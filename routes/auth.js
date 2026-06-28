import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Session from "../models/Session.js";

const router = Router();
const SESSION_DAYS = 7;
const COOKIE_NAME = "session_token";

const DEFAULT_MASTERS = [
  { userId: "advik", password: "Advik@#456", name: "Advik" },
  { userId: "admin", password: "admin123", name: "Admin" },
];

export async function seedMasters() {
  for (const m of DEFAULT_MASTERS) {
    const exists = await User.findOne({ userId: m.userId, role: "master" });
    if (exists) continue;
    const passwordHash = await bcrypt.hash(m.password, 10);
    await User.create({
      userId: m.userId,
      passwordHash,
      name: m.name,
      role: "master",
    });
    console.log(`Seeded master account: ${m.userId}`);
  }
}

function sessionExpiry() {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

async function createSession(res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  await Session.create({
    token,
    userId: user.userId,
    name: user.name || "",
    role: user.role,
    expiresAt: sessionExpiry(),
  });
  res.cookie(COOKIE_NAME, token, cookieOptions());
  return { role: user.role, userId: user.userId, name: user.name || "" };
}

async function getSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const session = await Session.findOne({ token, expiresAt: { $gt: new Date() } });
  if (!session) return null;
  return {
    role: session.role,
    userId: session.userId,
    name: session.name || "",
  };
}

async function requireMaster(req, res, next) {
  const session = await getSession(req);
  if (!session || session.role !== "master") {
    return res.status(401).json({ error: "Master login required." });
  }
  req.session = session;
  next();
}

router.get("/session", async (req, res) => {
  const session = await getSession(req);
  if (!session) return res.json({ session: null });
  res.json({ session });
});

router.post("/master/login", async (req, res) => {
  try {
    const userId = String(req.body.userId || "").trim().toLowerCase();
    const password = String(req.body.password || "").trim();
    if (!userId || !password) {
      return res.status(400).json({ error: "User ID and password are required." });
    }
    const user = await User.findOne({ userId, role: "master" });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid master credentials." });
    }
    const session = await createSession(res, user);
    res.json({ ok: true, session });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login failed." });
  }
});

router.post("/user/login", async (req, res) => {
  try {
    const userId = String(req.body.userId || "").trim().toLowerCase();
    const password = String(req.body.password || "").trim();
    if (!userId || !password) {
      return res.status(400).json({ error: "User ID and password are required." });
    }
    const user = await User.findOne({ userId, role: "user" });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid user ID or password." });
    }
    const session = await createSession(res, user);
    res.json({ ok: true, session });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login failed." });
  }
});

router.post("/logout", async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) await Session.deleteOne({ token });
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

router.get("/users", requireMaster, async (_req, res) => {
  const users = await User.find({ role: "user" })
    .select("userId name createdAt")
    .sort({ createdAt: -1 })
    .lean();
  res.json({ users });
});

router.post("/users", requireMaster, async (req, res) => {
  try {
    const userId = String(req.body.userId || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const name = String(req.body.name || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required." });
    if (password.length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters." });
    }
    const exists = await User.findOne({ userId });
    if (exists) return res.status(409).json({ error: "User ID already exists." });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ userId, passwordHash, name, role: "user" });
    res.status(201).json({
      user: { userId: user.userId, name: user.name, createdAt: user.createdAt },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not create user." });
  }
});

export default router;
