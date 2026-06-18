"use strict";
const router  = require("express").Router();
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const { z }   = require("zod");
const { prisma } = require("../config/db");
const { redis }  = require("../config/redis");
const { requireAuth } = require("../middleware/auth");
const logger  = require("../config/logger");

const LoginSchema = z.object({
  account:  z.string().min(1),   // 接受帳號名稱或 email
  password: z.string().min(6),
});

// ── POST /api/auth/login ──────────────────────────────────────
router.post("/login", async (req, res) => {
  const parse = LoginSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "Invalid input" });

  const { account, password } = parse.data;

  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { name:  { equals: account, mode: "insensitive" } },
          { email: { equals: account, mode: "insensitive" } },
        ],
      },
    });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: "帳號不存在或已停用" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      logger.warn(`Failed login attempt for ${account} from ${req.ip}`);
      return res.status(401).json({ error: "密碼錯誤" });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
    );

    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

    // Persist session
    await prisma.session.create({
      data: {
        userId:    user.id,
        token,
        expiresAt,
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      },
    });

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data:  { lastLoginAt: new Date() },
    });

    // Audit log
    await prisma.auditLog.create({
      data: { userId: user.id, action: "user.login", ipAddress: req.ip },
    });

    logger.info(`User ${account} logged in from ${req.ip}`);

    res.json({
      token,
      expiresAt,
      user: {
        id:    user.id,
        email: user.email,
        name:  user.name,
        role:  user.role,
      },
    });
  } catch (err) {
    logger.error("Login error:", err);
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post("/logout", requireAuth, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      await prisma.session.deleteMany({ where: { token } });
      // Blacklist token in Redis for remaining TTL
      const decoded = jwt.decode(token);
      if (decoded?.exp) {
        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) await redis.setex(`blacklist:${token}`, ttl, "1");
      }
    }
    res.json({ message: "已登出" });
  } catch (err) {
    res.status(500).json({ error: "登出失敗" });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true, role: true, lastLoginAt: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// ── POST /api/auth/change-password ───────────────────────────
router.post("/change-password", requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "新密碼至少 8 個字元" });
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const valid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "舊密碼錯誤" });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.userId }, data: { passwordHash } });
    // Invalidate all sessions
    await prisma.session.deleteMany({ where: { userId: req.userId } });

    await prisma.auditLog.create({
      data: { userId: req.userId, action: "user.change_password", ipAddress: req.ip },
    });
    res.json({ message: "密碼已更新，請重新登入" });
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

module.exports = router;
