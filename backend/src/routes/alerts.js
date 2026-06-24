"use strict";
// src/routes/alerts.js
const router = require("express").Router();
const { prisma } = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET /api/alerts?accountId=&level=&resolved=false
router.get("/", requireAuth, async (req, res) => {
  try {
    const { accountId, level, resolved } = req.query;
    const where = {
      ...(accountId ? { accountId } : {}),
      ...(level     ? { level: level.toUpperCase() } : {}),
      isResolved: resolved === "true",
    };
    const alerts = await prisma.alert.findMany({
      where,
      include: { account: { select: { name: true, alias: true, color: true } } },
      orderBy: [{ level: "asc" }, { createdAt: "desc" }],
      take: 100,
    });
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// GET /api/alerts/summary — 各帳號告警計數
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const summary = await prisma.alert.groupBy({
      by: ["accountId", "level"],
      where: { isResolved: false },
      _count: true,
    });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// PUT /api/alerts/:id/resolve — 標記已處理
router.put("/:id/resolve", requireAuth, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  try {
    const alert = await prisma.alert.update({
      where: { id: req.params.id },
      data:  { isResolved: true, resolvedAt: new Date(), resolvedBy: req.userId },
    });
    await prisma.auditLog.create({
      data: { userId: req.userId, action: "alert.resolve", target: req.params.id, ipAddress: req.ip },
    });
    res.json(alert);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "告警不存在" });
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

module.exports = router;
