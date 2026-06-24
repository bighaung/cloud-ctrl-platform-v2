"use strict";
// src/routes/users.js
const router  = require("express").Router();
const bcrypt  = require("bcryptjs");
const { z }   = require("zod");
const { prisma }    = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const CreateUserSchema = z.object({
  email:    z.string().email(),
  name:     z.string().min(1),
  password: z.string().min(8),
  role:     z.enum(["ADMIN", "OPERATOR", "VIEWER"]).default("VIEWER"),
});

// GET /api/users
router.get("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, isActive: true, lastLoginAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// POST /api/users
router.post("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parse = CreateUserSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.issues });

  try {
    const passwordHash = await bcrypt.hash(parse.data.password, 12);
    const user = await prisma.user.create({
      data: { ...parse.data, passwordHash, password: undefined },
      select: { id: true, email: true, name: true, role: true },
    });
    await prisma.auditLog.create({
      data: { userId: req.userId, action: "user.create", target: user.id, ipAddress: req.ip },
    });
    res.status(201).json(user);
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Email 已存在" });
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// PUT /api/users/:id/toggle — 啟用/停用
router.put("/:id/toggle", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: "用戶不存在" });
    if (user.id === req.userId) return res.status(400).json({ error: "不能停用自己" });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data:  { isActive: !user.isActive },
      select: { id: true, isActive: true },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// PUT /api/users/:id/role — 修改角色
router.put("/:id/role", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { role } = req.body;
    if (!["ADMIN", "OPERATOR", "VIEWER"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    // 防止 admin 降級自己（避免系統失去最後一個 admin）
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: "不能修改自己的角色" });
    }
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data:  { role },
      select: { id: true, role: true },
    });
    res.json(updated);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "用戶不存在" });
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

module.exports = router;
