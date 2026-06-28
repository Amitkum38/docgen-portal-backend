import mongoose from "mongoose";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

function normalizeMongoUri(raw) {
  if (typeof raw !== "string") return "";
  let uri = raw.trim();
  while (
    (uri.startsWith('"') && uri.endsWith('"')) ||
    (uri.startsWith("'") && uri.endsWith("'"))
  ) {
    uri = uri.slice(1, -1).trim();
  }
  return uri.replace(/\r?\n/g, "");
}

function redactUri(uri) {
  return uri.replace(/:([^:@/]+)@/, ":***@");
}

export async function connectDB() {
  const uris = [
    normalizeMongoUri(process.env.MONGODB_URI),
    normalizeMongoUri(process.env.MONGODB_STANDARD_URI),
  ].filter(Boolean);

  if (uris.length === 0) {
    throw new Error("❌ MONGODB_URI is not set.");
  }

  let lastErr;

  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000,
        family: 4,
      });

      console.log("✅ MongoDB Connected");
      return;
    } catch (err) {
      lastErr = err;
      console.error(`❌ MongoDB connection failed (${redactUri(uri)}):`, err.message);

      if (err.code === "ENOTFOUND" && uri.startsWith("mongodb+srv://")) {
        console.error(
          "   Atlas SRV hostname could not be resolved. Copy the connection string again from",
          "MongoDB Atlas (Connect → Drivers), or use the standard mongodb:// URI as MONGODB_STANDARD_URI.",
        );
      }

      if (i < uris.length - 1) {
        console.warn("Trying fallback MongoDB URI...");
      }
    }
  }

  console.error("❌ MongoDB Connection Error:");
  console.error(lastErr);
  process.exit(1);
}
