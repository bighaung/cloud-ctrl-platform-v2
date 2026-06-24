"use strict";
// src/routes/resources.js
const router = require("express").Router();
const { prisma } = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const aliyun = require("../services/aliyun");

// GET /api/resources/:accountId/ecs
router.get("/:accountId/ecs", requireAuth, requireRole("ADMIN", "OPERATOR", "VIEWER"), async (req, res) => {
  try {
    const account = await prisma.cloudAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) return res.status(404).json({ error: "帳號不存在" });
    const data = await aliyun.fetchECS(account.roleArn, account.region);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// GET /api/resources/:accountId/billing
router.get("/:accountId/billing", requireAuth, requireRole("ADMIN", "OPERATOR", "VIEWER"), async (req, res) => {
  try {
    const account = await prisma.cloudAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) return res.status(404).json({ error: "帳號不存在" });
    const data = await aliyun.fetchBilling(account.roleArn);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// GET /api/resources/overview — 所有帳號最新快照
router.get("/overview", requireAuth, requireRole("ADMIN", "OPERATOR", "VIEWER"), async (req, res) => {
  try {
    const accounts = await prisma.cloudAccount.findMany({
      where: { isActive: true },
      include: {
        snapshots: { orderBy: { snapAt: "desc" }, take: 1 },
        alerts: {
          where: { isResolved: false },
          select: { level: true },
        },
      },
    });
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// GET /api/resources/:accountId/history — 費用歷史趨勢
router.get("/:accountId/history", requireAuth, requireRole("ADMIN", "OPERATOR", "VIEWER"), async (req, res) => {
  try {
    const snapshots = await prisma.resourceSnapshot.findMany({
      where: { accountId: req.params.accountId },
      orderBy: { snapAt: "desc" },
      take: 180, // 6 months
      select: { snapAt: true, monthCost: true, ecsCount: true },
    });
    res.json(snapshots.reverse());
  } catch (err) {
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

module.exports = router;
