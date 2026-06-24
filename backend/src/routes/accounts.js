"use strict";
const router  = require("express").Router();
const crypto  = require("crypto");
const { z }   = require("zod");
const { prisma }      = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const aliyunService   = require("../services/aliyun");
const tencentService  = require("../services/tencent");
const { redis }       = require("../config/redis");
const logger          = require("../config/logger");

// AES-256-GCM 加密：優先使用獨立的 ENCRYPTION_KEY env var
// 若未設定則 fallback 至 JWT_SECRET（維持向下相容），但兩者應分開
function getEncKey() {
  const raw = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!raw) throw new Error("缺少 ENCRYPTION_KEY 或 JWT_SECRET 環境變數");
  return Buffer.from(raw.padEnd(32).slice(0, 32));
}

function encrypt(text) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncKey(), iv);
  const enc    = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return iv.toString("hex") + ":" + enc.toString("hex") + ":" + tag.toString("hex");
}

function decrypt(enc) {
  const [ivHex, dataHex, tagHex] = enc.split(":");
  const iv      = Buffer.from(ivHex,   "hex");
  const data    = Buffer.from(dataHex, "hex");
  const tag     = Buffer.from(tagHex,  "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

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
  // 騰訊雲專用（schema 層 optional，handler 層強制驗證）
  secretId:    z.string().optional(),
  secretKey:   z.string().optional(),
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
    // 遮蔽 credentials，不回傳 secretId / secretKey 到前端
    const safe = accounts.map(a => ({
      ...a,
      credentials: a.credentials ? { hasKey: true } : null,
    }));
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts
router.post("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parse = AccountSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.issues });

  const { provider, accountId, roleArn, secretId, secretKey, ...rest } = parse.data;

  try {
    if (provider === "ALIYUN") {
      // 驗證阿里雲 Role ARN
      if (!roleArn) return res.status(400).json({ error: "阿里雲帳號需要 Role ARN" });
      const testResult = await aliyunService.testConnection(roleArn, rest.region);
      if (!testResult.ok) {
        return res.status(400).json({ error: `無法連線至帳號: ${testResult.error}` });
      }
    } else {
      // 驗證騰訊雲 SecretId / SecretKey
      if (!secretId || !secretKey) {
        return res.status(400).json({ error: "騰訊雲帳號需要 SecretId 和 SecretKey" });
      }
      const testResult = await tencentService.testConnection({ secretId, secretKey, region: rest.region });
      if (!testResult.ok) {
        return res.status(400).json({ error: `無法連線至騰訊雲: ${testResult.error}` });
      }
    }

    const createData = {
      provider,
      ...rest,
      alias: rest.alias.toUpperCase(),
      ...(provider === "ALIYUN"
        ? { aliyunAccountId: accountId, roleArn }
        : {
            tencentAppId: accountId,
            credentials: {
              secretId,
              secretKeyEncrypted: encrypt(secretKey),
            },
          }),
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
      aliyunService.syncAccount(account).catch(err => logger.error("background sync failed:", err));
    } else {
      tencentService.syncAccount({
        ...account,
        credentials: { secretId, secretKey },
      }).catch(err => logger.error("background sync failed:", err));
    }

    res.status(201).json({ ...account, credentials: account.credentials ? { hasKey: true } : null });
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

  // 只允許更新安全的顯示欄位，拒絕修改 credentials / roleArn / provider
  const { name, alias, region, description, color, budgetLimit } = parse.data;
  const allowedUpdate = Object.fromEntries(
    Object.entries({ name, alias, region, description, color, budgetLimit })
      .filter(([, v]) => v !== undefined)
  );

  try {
    const account = await prisma.cloudAccount.update({
      where: { id: req.params.id },
      data: allowedUpdate,
    });
    await redis.del(`account:${req.params.id}:resources`);
    res.json({ ...account, credentials: account.credentials ? { hasKey: true } : null });
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

    if (account.provider === "TENCENT") {
      const creds = account.credentials;
      if (!creds?.secretId || !creds?.secretKeyEncrypted) {
        return res.status(400).json({ error: "缺少騰訊雲憑證，請重新新增帳號" });
      }
      tencentService.syncAccount({
        ...account,
        credentials: {
          secretId:  creds.secretId,
          secretKey: decrypt(creds.secretKeyEncrypted),
        },
      }).catch(err => logger.error("background sync failed:", err));
    } else {
      aliyunService.syncAccount(account).catch(err => logger.error("background sync failed:", err));
    }

    res.json({ message: "同步已觸發，請稍後刷新" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
