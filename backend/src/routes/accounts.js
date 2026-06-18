"use strict";
const router  = require("express").Router();
const { z }   = require("zod");
const { prisma }      = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const aliyunService   = require("../services/aliyun");
const { redis }       = require("../config/redis");

const AccountSchema = z.object({
  provider:    z.enum(["ALIYUN", "TENCENT"]).default("ALIYUN"),
  name:        z.string().min(1).max(50),
  alias:       z.string().min(1).max(10),
  accountId:   z.string().min(1),
  roleArn:     z.string().optional(),
  region:      z.string().default("cn-hangzhou"),
  description: z.string().optional(),
  color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#00d4aa"),
  budgetLimit: z.number().positive().optional(),
});

// GET /api/accounts
router.get("/", requireAuth, async (req, res) => {
  try {
    const accounts = await prisma.cloudAccount.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { alerts: { where: { isResolved: false } } } },
        snapshots: { orderBy: { snapAt: "desc" }, take: 1 },
      },
    });
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts
router.post("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parse = AccountSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.issues });

  const { provider, accountId, roleArn, ...rest } = parse.data;

  try {
    // Test Aliyun connectivity (non-blocking warning if fails)
    if (provider === "ALIYUN" && roleArn) {
      const testResult = await aliyunService.testConnection(roleArn, rest.region);
      if (!testResult.ok) {
        return res.status(400).json({ error: `無法連線至帳號: ${testResult.error}` });
      }
    }

    const createData = {
      provider,
      ...rest,
      alias: rest.alias.toUpperCase(),
      ...(provider === "ALIYUN"
        ? { aliyunAccountId: accountId, roleArn }
        : { tencentAppId: accountId }),
    };

    const account = await prisma.cloudAccount.create({ data: createData });

    await prisma.auditLog.create({
      data: {
        userId: req.userId,
        action: "account.create",
        target: account.id,
        detail: { name: account.name, provider },
        ipAddress: req.ip,
      },
    });

    if (provider === "ALIYUN") {
      aliyunService.syncAccount(account).catch(console.error);
    }

    res.status(201).json(account);
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "別名已存在，請換一個" });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/accounts/:id
router.put("/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parse = AccountSchema.partial().safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.issues });

  try {
    const account = await prisma.cloudAccount.update({
      where: { id: req.params.id },
      data: parse.data,
    });
    await redis.del(`account:${req.params.id}:resources`);
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts/:id
router.delete("/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    await prisma.cloudAccount.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    await prisma.auditLog.create({
      data: { userId: req.userId, action: "account.disable", target: req.params.id, ipAddress: req.ip },
    });
    res.json({ message: "帳號已停用" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:id/sync
router.post("/:id/sync", requireAuth, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  try {
    const account = await prisma.cloudAccount.findUnique({ where: { id: req.params.id } });
    if (!account) return res.status(404).json({ error: "帳號不存在" });
    aliyunService.syncAccount(account).catch(console.error);
    res.json({ message: "同步已觸發，請稍後刷新" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
