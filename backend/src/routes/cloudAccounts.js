"use strict";
/**
 * routes/cloudAccounts.js
 * 統一管理阿里雲 + 騰訊雲帳號的 CRUD
 */
const router   = require("express").Router();
const crypto   = require("crypto");
const { z }    = require("zod");
const { prisma }  = require("../config/db");
const { redis }   = require("../config/redis");
const { requireAuth, requireRole } = require("../middleware/auth");
const aliyun   = require("../services/aliyun");
const tencent  = require("../services/tencent");
const logger   = require("../config/logger");

// SecretKey 加密（AES-256-GCM），Key 來自 JWT_SECRET 前 32 bytes
function encrypt(text) {
  const key = Buffer.from(process.env.JWT_SECRET.padEnd(32).slice(0, 32));
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc  = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return iv.toString("hex") + ":" + enc.toString("hex") + ":" + tag.toString("hex");
}

function decrypt(enc) {
  const [ivHex, dataHex, tagHex] = enc.split(":");
  const key    = Buffer.from(process.env.JWT_SECRET.padEnd(32).slice(0, 32));
  const iv     = Buffer.from(ivHex, "hex");
  const data   = Buffer.from(dataHex, "hex");
  const tag    = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// ── Validation Schemas ────────────────────────────────────────
const AliyunSchema = z.object({
  provider:        z.literal("ALIYUN"),
  name:            z.string().min(1).max(50),
  alias:           z.string().min(1).max(10),
  region:          z.string().default("cn-hangzhou"),
  description:     z.string().optional(),
  color:           z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#00d4aa"),
  budgetLimit:     z.number().positive().optional(),
  aliyunAccountId: z.string().regex(/^\d{16}$/, "需為 16 位數字"),
  roleArn:         z.string().startsWith("acs:ram::"),
});

const TencentSchema = z.object({
  provider:    z.literal("TENCENT"),
  name:        z.string().min(1).max(50),
  alias:       z.string().min(1).max(10),
  region:      z.string().default("ap-guangzhou"),
  description: z.string().optional(),
  color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#4a9eff"),
  budgetLimit: z.number().positive().optional(),
  tencentAppId: z.string().optional(),
  secretId:    z.string().min(1, "SecretId 必填"),
  secretKey:   z.string().min(1, "SecretKey 必填"),
});

const AccountSchema = z.discriminatedUnion("provider", [AliyunSchema, TencentSchema]);

// ── GET /api/cloud-accounts ───────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const accounts = await prisma.cloudAccount.findMany({
      where: { isActive: true },
      orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
      include: {
        _count: { select: { alerts: { where: { isResolved: false } } } },
        snapshots: { orderBy: { snapAt: "desc" }, take: 1 },
      },
    });

    // 過濾掉 credentials 中的 secretKey，不回傳前端
    const safe = accounts.map(a => ({
      ...a,
      credentials: a.credentials
        ? { secretId: a.credentials.secretId, hasKey: true }
        : null,
    }));

    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cloud-accounts/summary ──────────────────────────
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const [byProvider, totalCost, alertCounts] = await Promise.all([
      prisma.cloudAccount.groupBy({
        by: ["provider"],
        where: { isActive: true },
        _count: true,
      }),
      prisma.resourceSnapshot.aggregate({
        where: {
          account: { isActive: true },
          snapAt: { gte: new Date(new Date().setDate(1)) }, // 本月
        },
        _sum: { monthCost: true },
      }),
      prisma.alert.groupBy({
        by: ["level"],
        where: { isResolved: false },
        _count: true,
      }),
    ]);

    res.json({ byProvider, totalCost: totalCost._sum.monthCost || 0, alertCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/cloud-accounts ──────────────────────────────────
router.post("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parse = AccountSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.issues });

  const data = parse.data;

  try {
    // 測試連線
    let testResult;
    if (data.provider === "ALIYUN") {
      testResult = await aliyun.testConnection(data.roleArn, data.region);
    } else {
      testResult = await tencent.testConnection({
        secretId: data.secretId, secretKey: data.secretKey, region: data.region,
      });
    }

    if (!testResult.ok) {
      return res.status(400).json({ error: `無法連線: ${testResult.error}` });
    }

    // 騰訊雲：加密存儲 SecretKey
    let credentials = null;
    if (data.provider === "TENCENT") {
      credentials = {
        secretId:            data.secretId,
        secretKeyEncrypted:  encrypt(data.secretKey),
      };
    }

    const account = await prisma.cloudAccount.create({
      data: {
        provider:        data.provider,
        name:            data.name,
        alias:           data.alias.toUpperCase(),
        region:          data.region,
        description:     data.description,
        color:           data.color,
        budgetLimit:     data.budgetLimit,
        aliyunAccountId: data.provider === "ALIYUN" ? data.aliyunAccountId : null,
        roleArn:         data.provider === "ALIYUN" ? data.roleArn : null,
        tencentAppId:    data.provider === "TENCENT" ? data.tencentAppId : null,
        credentials,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.userId,
        action: "cloud_account.create",
        target: account.id,
        detail: { provider: account.provider, name: account.name },
        ipAddress: req.ip,
      },
    });

    // 背景觸發同步
    const syncFn = data.provider === "ALIYUN" ? aliyun.syncAccount : tencent.syncAccount;
    syncFn({ ...account, credentials: data.provider === "TENCENT"
      ? { secretId: data.secretId, secretKey: data.secretKey }
      : null,
    }).catch(logger.error);

    res.status(201).json({ ...account, credentials: null });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "別名已存在" });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/cloud-accounts/:id/sync ────────────────────────
router.post("/:id/sync", requireAuth, requireRole("ADMIN", "OPERATOR"), async (req, res) => {
  try {
    const account = await prisma.cloudAccount.findUnique({ where: { id: req.params.id } });
    if (!account) return res.status(404).json({ error: "帳號不存在" });

    // 解密 SecretKey
    let syncAccount = { ...account };
    if (account.provider === "TENCENT" && account.credentials?.secretKeyEncrypted) {
      syncAccount.credentials = {
        secretId:  account.credentials.secretId,
        secretKey: decrypt(account.credentials.secretKeyEncrypted),
      };
    }

    const syncFn = account.provider === "ALIYUN" ? aliyun.syncAccount : tencent.syncAccount;
    syncFn(syncAccount).catch(logger.error);

    res.json({ message: "同步已觸發" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/cloud-accounts/:id ───────────────────────────
router.delete("/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    await prisma.cloudAccount.update({
      where: { id: req.params.id },
      data:  { isActive: false },
    });
    // 清除快取
    await redis.del(`tencent:cvm:*`);
    await redis.del(`tencent:billing:*`);
    res.json({ message: "帳號已停用" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cloud-accounts/:id/debug-subscriptions ──────────
// 暫時診斷用：回傳 BSS QueryAvailableInstances 原始結果
router.get("/:id/debug-subscriptions", requireAuth, async (req, res) => {
  try {
    const account = await prisma.cloudAccount.findUnique({ where: { id: req.params.id } });
    if (!account) return res.status(404).json({ error: "帳號不存在" });

    const Core = require("@alicloud/pop-core");
    const { redis: rd } = require("../config/redis");

    // 取臨時憑證
    const cached = await rd.get(`sts:${account.roleArn}`);
    if (!cached) return res.status(400).json({ error: "STS token not cached, sync first" });
    const creds = JSON.parse(cached);

    const bssClient = new Core({
      accessKeyId:     creds.AccessKeyId,
      accessKeySecret: creds.AccessKeySecret,
      securityToken:   creds.SecurityToken,
      endpoint:        "https://business.aliyuncs.com",
      apiVersion:      "2017-12-14",
    });

    // 查不帶 ProductCode 的全量
    const raw = await bssClient.request("QueryAvailableInstances", { PageNum: 1, PageSize: 100 });

    // 也試試幾個常見 ProductCode
    const probes = {};
    for (const code of ["kvstore", "redisa", "eip", "sas", "cloud_siem", "aegis", "alimail"]) {
      try {
        const r = await bssClient.request("QueryAvailableInstances", { PageNum: 1, PageSize: 100, ProductCode: code });
        probes[code] = { total: r.Data?.TotalCount, items: r.Data?.InstanceList?.Instance || [] };
      } catch (e) {
        probes[code] = { error: e.message };
      }
    }

    res.json({ allInstances: raw.Data, probes });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

module.exports = router;
