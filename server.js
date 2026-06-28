import "dotenv/config";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import zlib from "node:zlib";
import cookieParser from "cookie-parser";
import { pdfToPng } from "pdf-to-png-converter";
import { createWorker } from "tesseract.js";
import { readBarcodesFromImageFile } from "zxing-wasm/reader";
import { connectDB } from "./db.js";
import authRouter, { seedMasters } from "./routes/auth.js";

const app = express();
app.set("trust proxy", 1);

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""));

app.use((req, res, next) => {
  const origin = req.headers.origin?.replace(/\/$/, "");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(cookieParser());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "Digital Document Generator API is running.",
    frontend: "Open your Vercel frontend app in the browser — this URL is for API only.",
    endpoints: { health: "/health", auth: "/auth", extract: "POST /extract" },
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/auth", authRouter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(express.static("public"));

// ---- one reusable OCR worker ----
let ocrWorker;
async function getOcr() {
  if (!ocrWorker) ocrWorker = await createWorker("eng");
  return ocrWorker;
}

// Get a base PNG buffer: PDFs render at high DPI; images are passed through as-is
// (we resize per-attempt later, because a forced single size can BREAK QR decoding).
async function rasterizeBase(file) {
  const isPdf =
    file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname);
  if (isPdf) {
    const pages = await pdfToPng(file.buffer, {
      viewportScale: 3.5,
      pagesToProcess: [1],
    });
    if (!pages.length) throw new Error("Could not render the PDF.");
    return pages[0].content;
  }
  return file.buffer;
}

// ---------- Aadhaar QR decoding ----------
// Aadhaar QR codes are dense and decode best near a "sweet spot" resolution that
// differs per image — so we try several widths (incl. the original) until one works.
async function decodeQr(baseBuffer) {
  let nativeW = 0;
  try { nativeW = (await sharp(baseBuffer).metadata()).width || 0; } catch {}
  const widths = [...new Set([nativeW, 1100, 1500, 2000, 2600, 3200].filter((w) => w > 200))]
    .sort((a, b) => a - b);

  for (const w of widths) {
    let buf;
    try { buf = await sharp(baseBuffer).resize({ width: w, withoutEnlargement: false }).png().toBuffer(); }
    catch { continue; }
    const results = await readBarcodesFromImageFile(new Blob([buf]), {
      formats: ["QRCode"],
      tryHarder: true,
      tryInvert: true,
      maxNumberOfSymbols: 5,
    });
    for (const r of results) {
      const parsed = parseAadhaarQr(r);
      if (parsed && Object.keys(parsed).length) return parsed;
    }
  }
  return null;
}

function parseAadhaarQr(result) {
  const text = (result.text || "").trim();
  // Old style: plain XML
  if (/^<\?xml|<PrintLetterBarcodeData|uid=|\bname="/.test(text))
    return parseXmlQr(text);
  // Secure QR (2018+): big decimal integer -> bytes -> gunzip -> 0xFF-delimited fields
  if (/^\d{50,}$/.test(text)) {
    try {
      let hex = BigInt(text).toString(16);
      if (hex.length % 2) hex = "0" + hex;
      const raw = Buffer.from(hex, "hex");
      let inflated;
      try {
        inflated = zlib.gunzipSync(raw);
      } catch {
        inflated = zlib.inflateSync(raw);
      }
      return parseSecureFields(inflated);
    } catch (e) {
      console.warn("secure QR decode failed:", e.message);
      return null;
    }
  }
  // Some readers hand back the gzipped bytes directly
  if (result.bytes && result.bytes.length) {
    try {
      const raw = Buffer.from(result.bytes);
      let inflated;
      try {
        inflated = zlib.gunzipSync(raw);
      } catch {
        inflated = zlib.inflateSync(raw);
      }
      return parseSecureFields(inflated);
    } catch {
      /* fall through */
    }
  }
  return null;
}

function parseSecureFields(buf) {
  const stops = [];
  for (let i = 0; i < buf.length && stops.length < 20; i++)
    if (buf[i] === 255) stops.push(i);
  const field = (k) => {
    const start = k === 0 ? 0 : stops[k - 1] + 1;
    const end = stops[k];
    if (end === undefined) return "";
    return buf.slice(start, end).toString("utf8").trim();
  };
  // 0:indicator 1:refId 2:name 3:dob 4:gender 5:careof 6:district 7:landmark
  // 8:house 9:location 10:pincode 11:postoffice 12:state 13:street 14:subdist 15:vtc
  const g = field(4).toUpperCase();
  const addr = dedupe(
    [
      field(8),
      field(13),
      field(7),
      field(9),
      field(15),
      field(11),
      field(14),
      field(6),
      field(12),
      field(10),
    ]
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const out = {};
  if (field(2)) out.name = field(2);
  if (field(3)) out.dob = field(3).replace(/-/g, "/");
  if (g)
    out.gender =
      g === "M"
        ? "Male"
        : g === "F"
          ? "Female"
          : g === "T"
            ? "Transgender"
            : field(4);
  if (field(5))
    out.co = field(5)
      .replace(/^(S\/O|D\/O|W\/O|C\/O)\s*:?\s*/i, "")
      .trim();
  if (addr.length) out.address = addr.join(", ");
  if (field(15)) out.village = field(15);
  if (field(14)) out.subdist = field(14);
  if (field(12)) out.state = field(12).toUpperCase();
  return out;
}

function parseXmlQr(s) {
  const get = (a) => {
    const m = s.match(new RegExp(a + '="([^"]*)"', "i"));
    return m ? m[1].trim() : "";
  };
  const out = {};
  if (get("name")) out.name = get("name");
  const dob = get("dob") || get("yob");
  if (dob) out.dob = dob.replace(/-/g, "/");
  const g = get("gender").toUpperCase();
  if (g)
    out.gender =
      g === "M" ? "Male" : g === "F" ? "Female" : g === "T" ? "Transgender" : g;
  if (get("co"))
    out.co = get("co")
      .replace(/^(S\/O|D\/O|W\/O|C\/O)\s*:?\s*/i, "")
      .trim();
  const addr = dedupe(
    [
      "house",
      "street",
      "lm",
      "loc",
      "vtc",
      "po",
      "subdist",
      "dist",
      "state",
      "pc",
    ]
      .map(get)
      .filter(Boolean),
  );
  if (addr.length) out.address = addr.join(", ");
  if (get("vtc")) out.village = get("vtc");
  if (get("subdist")) out.subdist = get("subdist");
  if (get("state")) out.state = get("state").toUpperCase();
  return out;
}

function dedupe(arr) {
  const seen = new Set(),
    res = [];
  for (const x of arr) {
    const k = x.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      res.push(x);
    }
  }
  return res;
}

// ---------- OCR (only needed for the full 12-digit Aadhaar number) ----------
function parseOcr(text) {
  const out = {};
  const clean = (text || "").replace(/\r/g, "");
  const groups = clean.match(/\b\d{4}\s?\d{4}\s?\d{4}\b/g);
  if (groups) out.aadhar = groups[0].replace(/\s/g, "");
  let m = clean.match(/(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/);
  if (m) out.dob = `${m[1]}/${m[2]}/${m[3]}`;
  else {
    m = clean.match(/year of birth\s*[:\-]?\s*(\d{4})/i);
    if (m) out.dob = m[1];
  }
  m = clean.match(/\b(female|male|transgender)\b/i);
  if (m)
    out.gender = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return out;
}

// ---------- main endpoint ----------
app.post("/extract", upload.single("aadhaar"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    let base;
    try {
      base = await rasterizeBase(req.file);
    } catch (e) {
      return res
        .status(400)
        .json({ error: "Could not read the file. " + e.message });
    }

    // 1) QR first (exact data) — tries several resolutions internally
    let qr = null;
    try {
      qr = await decodeQr(base);
    } catch (e) {
      console.warn("QR error:", e.message);
    }

    // 2) OCR for the Aadhaar number (and as a fallback for dob/gender).
    //    Upscale + grayscale + normalize so the text reads better.
    let ocrText = "",
      ocr = {};
    try {
      const ocrBuf = await sharp(base)
        .resize({ width: 2000, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .png()
        .toBuffer();
      const worker = await getOcr();
      const { data } = await worker.recognize(ocrBuf);
      ocrText = data.text || "";
      ocr = parseOcr(ocrText);
    } catch (e) {
      console.warn("OCR error:", e.message);
    }

    const fields = Object.assign({}, ocr, qr || {});
    if (!fields.aadhar && ocr.aadhar) fields.aadhar = ocr.aadhar;

    res.json({
      source: qr ? "qr" : Object.keys(ocr).length ? "ocr" : "none",
      fields,
      rawText: ocrText,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error: " + e.message });
  }
});

const PORT = process.env.PORT || 9000;

async function start() {
  await connectDB();
  await seedMasters();
  app.listen(PORT, () =>
    console.log(`Mera Kisan Card running:  http://localhost:${PORT}`),
  );
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
