"use strict";
/**
 * tencentService — 騰訊雲 API 整合層
 *
 * 騰訊雲子帳號結構：主帳號下多個子帳號（協作者/子用戶）
 * 每個子帳號有獨立的 SecretId / SecretKey，直接調用對應 API
 * 無需 STS AssumeRole（與阿里雲不同）
 */

const tencentcloud = require("tencentcloud-sdk-nodejs");
const { redis }    = require("../config/redis");
const { prisma }   = require("../config/db");
const logger       = require("../config/logger");

// ── SDK Clients ───────────────────────────────────────────────
const CvmClient     = tencentcloud.cvm.v20170312.Client;
const CdbClient     = tencentcloud.cdb.v20170320.Client;
const CosClient     = tencentcloud.cos; // COS 用獨立 SDK
const BillingClient = tencentcloud.billing.v20180709.Client;
const CloudauditClient = tencentcloud.cloudaudit.v20190319.Client;

// ── 建立帶憑證的 Client ────────────────────────────────────────
function makeClient(ClientClass, secretId, secretKey, region = "ap-guangzhou") {
  return new ClientClass({
    credential: { secretId, secretKey },
    region,
    profile: {
      httpProfile: { endpoint: undefined, reqTimeout: 30 },
    },
  });
}

// ── 測試連線 ──────────────────────────────────────────────────
async function testConnection({ secretId, secretKey, region }) {
  try {
    const client = makeClient(CvmClient, secretId, secretKey, region);
    await client.DescribeRegions({});
    return { ok: true };
  } catch (err) {
    logger.warn(`Tencent connection test failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── 拉取 CVM 實例 ─────────────────────────────────────────────
async function fetchCVM({ secretId, secretKey, region }) {
  const cacheKey = `tencent:cvm:${secretId}:${region}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = makeClient(CvmClient, secretId, secretKey, region);
  const result = await client.DescribeInstances({ Limit: 100 });

  const instances = result.InstanceSet || [];
  const data = {
    total:   result.TotalCount || 0,
    running: instances.filter(i => i.InstanceState === "RUNNING").length,
    stopped: instances.filter(i => i.InstanceState === "STOPPED").length,
    list: instances.map(i => ({
      id:          i.InstanceId,
      name:        i.InstanceName,
      status:      i.InstanceState,
      cpu:         i.CPU,
      memory:      i.Memory,
      publicIp:    i.PublicIpAddresses?.[0],
      privateIp:   i.PrivateIpAddresses?.[0],
      expireTime:  i.ExpiredTime,
      chargeType:  i.InstanceChargeType, // PREPAID / POSTPAID_BY_HOUR
    })),
  };

  await redis.setex(cacheKey, 5 * 60, JSON.stringify(data));
  return data;
}

// ── 拉取 CDB 資料庫 ───────────────────────────────────────────
async function fetchCDB({ secretId, secretKey, region }) {
  const cacheKey = `tencent:cdb:${secretId}:${region}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = makeClient(CdbClient, secretId, secretKey, region);
  const result = await client.DescribeDBInstances({ Limit: 100 });

  const items = result.Items || [];
  const data  = {
    total: result.TotalCount || 0,
    list: items.map(i => ({
      id:      i.InstanceId,
      name:    i.InstanceName,
      status:  i.Status, // 1=運行中
      engine:  i.Engine,
      version: i.EngineVersion,
      memory:  i.Memory,
      volume:  i.Volume,
    })),
  };

  await redis.setex(cacheKey, 5 * 60, JSON.stringify(data));
  return data;
}

// ── 拉取 COS Bucket 數 ────────────────────────────────────────
async function fetchCOS({ secretId, secretKey }) {
  const cacheKey = `tencent:cos:${secretId}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // COS 使用獨立 SDK（非 tencentcloud-sdk-nodejs 統一 SDK）
  const COS = require("cos-nodejs-sdk-v5");
  const cos  = new COS({ SecretId: secretId, SecretKey: secretKey });

  const result = await new Promise((resolve, reject) => {
    cos.getService({}, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

  const buckets = result.Buckets || [];
  const data    = {
    total: buckets.length,
    list: buckets.map(b => ({
      name:       b.Name,
      location:   b.Location,
      createDate: b.CreationDate,
    })),
  };

  await redis.setex(cacheKey, 10 * 60, JSON.stringify(data));
  return data;
}

// ── 拉取費用帳單（本月）───────────────────────────────────────
async function fetchBilling({ secretId, secretKey }) {
  const cacheKey = `tencent:billing:${secretId}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Billing API 不分 region，使用 ap-guangzhou
  const client = makeClient(BillingClient, secretId, secretKey, "ap-guangzhou");

  const now    = new Date();
  const month  = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastD  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastM  = `${lastD.getFullYear()}${String(lastD.getMonth() + 1).padStart(2, "0")}`;

  const [thisResult, lastResult] = await Promise.allSettled([
    client.DescribeBillSummaryByProduct({ Month: month, PayType: "postPay" }),
    client.DescribeBillSummaryByProduct({ Month: lastM, PayType: "postPay" }),
  ]);

  const thisMonth = thisResult.status === "fulfilled"
    ? parseFloat(thisResult.value.SummaryOverview?.[0]?.RealTotalCost || 0)
    : 0;
  const lastMonth = lastResult.status === "fulfilled"
    ? parseFloat(lastResult.value.SummaryOverview?.[0]?.RealTotalCost || 0)
    : 0;

  // 各產品費用明細
  const breakdown = {};
  if (thisResult.status === "fulfilled") {
    for (const item of thisResult.value.SummaryOverview || []) {
      breakdown[item.BusinessCodeName] = parseFloat(item.RealTotalCost || 0);
    }
  }

  const data = {
    currentMonth: thisMonth,
    lastMonth,
    trend: lastMonth > 0
      ? ((thisMonth - lastMonth) / lastMonth * 100).toFixed(1)
      : 0,
    breakdown,
    billingCycle: month,
  };

  await redis.setex(cacheKey, 30 * 60, JSON.stringify(data));
  return data;
}

// ── 拉取云審計安全事件 ────────────────────────────────────────
async function fetchSecurityEvents({ secretId, secretKey, region }) {
  const cacheKey = `tencent:audit:${secretId}:${region}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = makeClient(CloudauditClient, secretId, secretKey, region);

  const startTime = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const endTime   = Math.floor(Date.now() / 1000);

  const HIGH_RISK = [
    "DeleteAccessKey", "CreateAccessKey",
    "AddUser", "DeleteUser",
    "AttachUserPolicy", "DetachUserPolicy",
    "CreateRole", "DeleteRole",
    "AssumeRole",
  ];

  let events = [];
  try {
    const result = await client.LookUpEvents({
      StartTime:  startTime,
      EndTime:    endTime,
      MaxResults: 50,
    });
    events = (result.Events || []).filter(e => HIGH_RISK.includes(e.EventName));
  } catch (err) {
    logger.warn(`Tencent audit fetch failed: ${err.message}`);
  }

  await redis.setex(cacheKey, 5 * 60, JSON.stringify(events));
  return events;
}

// ── 完整帳號同步（寫入 DB）────────────────────────────────────
async function syncAccount(account) {
  logger.info(`Syncing Tencent account: ${account.name}`);

  // 從帳號設定取出憑證（存在 credentials JSON 欄位）
  const creds = account.credentials;
  if (!creds?.secretId || !creds?.secretKey) {
    logger.warn(`Missing credentials for Tencent account: ${account.name}`);
    return;
  }

  const params = {
    secretId:  creds.secretId,
    secretKey: creds.secretKey,
    region:    account.region || "ap-guangzhou",
  };

  const [cvm, cdb, cos, billing, secEvents] = await Promise.allSettled([
    fetchCVM(params),
    fetchCDB(params),
    fetchCOS(params),
    fetchBilling(params),
    fetchSecurityEvents(params),
  ]);

  const cvmData     = cvm.status     === "fulfilled" ? cvm.value     : { total: 0 };
  const cdbData     = cdb.status     === "fulfilled" ? cdb.value     : { total: 0 };
  const cosData     = cos.status     === "fulfilled" ? cos.value     : { total: 0 };
  const billingData = billing.status === "fulfilled" ? billing.value : { currentMonth: 0 };
  const secData     = secEvents.status === "fulfilled" ? secEvents.value : [];

  // 存快照（複用同一張 ResourceSnapshot 表）
  await prisma.resourceSnapshot.create({
    data: {
      accountId: account.id,
      ecsCount:  cvmData.total,   // CVM → ecsCount
      rdsCount:  cdbData.total,   // CDB → rdsCount
      ossCount:  cosData.total,   // COS → ossCount
      slbCount:  0,
      monthCost: billingData.currentMonth,
      rawData:   { cvm: cvmData, cdb: cdbData, cos: cosData, billing: billingData },
    },
  });

  // 安全告警
  for (const e of secData) {
    await prisma.alert.create({
      data: {
        accountId: account.id,
        level:     "WARNING",
        type:      "SECURITY",
        message:   `高風險操作: ${e.EventName} by ${e.Username || "unknown"}`,
        detail:    e,
      },
    }).catch(() => {});
  }

  // 預算告警
  if (account.budgetLimit && billingData.currentMonth > account.budgetLimit * 0.85) {
    const level = billingData.currentMonth > account.budgetLimit ? "CRITICAL" : "WARNING";
    await prisma.alert.create({
      data: {
        accountId: account.id,
        level,
        type:    "BILLING",
        message: `本月費用 ¥${billingData.currentMonth.toFixed(0)} 已達預算 ${((billingData.currentMonth / account.budgetLimit) * 100).toFixed(0)}%`,
      },
    }).catch(() => {});
  }

  logger.info(`Tencent sync complete: ${account.name}`);
}

module.exports = {
  testConnection,
  fetchCVM,
  fetchCDB,
  fetchCOS,
  fetchBilling,
  fetchSecurityEvents,
  syncAccount,
};
