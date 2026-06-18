"use strict";
// src/routes/resources.js
const router = require("express").Router();
const { prisma } = require("../config/db");
const { requireAuth } = require("../middleware/auth");
const aliyun = require("../services/aliyun");

// GET /api/resources/:accountId/ecs
router.get("/:accountId/ecs", requireAuth, async (req, res) => {
  try {
    const account = await prisma.aliyunAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) return res.status(404).json({ error: "帳號不存在" });
    const data = await aliyun.fetchECS(account.roleArn, account.region);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resources/:accountId/billing
router.get("/:accountId/billing", requireAuth, async (req, res) => {
  try {
    const account = await prisma.aliyunAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) return res.status(404).json({ error: "帳號不存在" });
    const data = await aliyun.fetchBilling(account.roleArn);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resources/overview — 所有帳號最新快照
router.get("/overview", requireAuth, async (req, res) => {
  try {
    const accounts = await prisma.aliyunAccount.findMany({
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
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resources/:accountId/history — 費用歷史趨勢
router.get("/:accountId/history", requireAuth, async (req, res) => {
  try {
    const snapshots = await prisma.resourceSnapshot.findMany({
      where: { accountId: req.params.accountId },
      orderBy: { snapAt: "desc" },
      take: 180, // 6 months
      select: { snapAt: true, monthCost: true, ecsCount: true },
    });
    res.json(snapshots.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
