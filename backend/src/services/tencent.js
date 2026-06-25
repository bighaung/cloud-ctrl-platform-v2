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
const CvmClient        = tencentcloud.cvm.v20170312.Client;
const CdbClient        = tencentcloud.cdb.v20170320.Client;
const CbsClient        = tencentcloud.cbs.v20170312.Client;
const CosClient        = tencentcloud.cos; // COS 用獨立 SDK
const BillingClient    = tencentcloud.billing.v20180709.Client;
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
      id:         i.InstanceId,
      name:       i.InstanceName,
      status:     i.Status === 1 ? "Running" : "Stopped",
      engine:     i.Engine,
      version:    i.EngineVersion,
      memory:     i.Memory,
      volume:     i.Volume,
      // PayType: 0=包年包月, 1=按量; DeadlineTime 格式 "2026-01-01 00:00:00"
      expireTime: i.PayType === 0 && i.DeadlineTime && !i.DeadlineTime.startsWith("0000")
        ? i.DeadlineTime : null,
      productCode: "cdb",
    })),
  };

  await redis.setex(cacheKey, 5 * 60, JSON.stringify(data));
  return data;
}

// ── 拉取 CBS 雲硬碟 ──────────────────────────────────────────
async function fetchCBS({ secretId, secretKey, region }) {
  const cacheKey = `tencent:cbs:${secretId}:${region}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = makeClient(CbsClient, secretId, secretKey, region);
  const result = await client.DescribeDisks({ Limit: 100, Offset: 0 });

  const disks = result.DiskSet || [];
  const data  = {
    total: result.TotalCount || 0,
    list: disks.map(d => ({
      id:          d.DiskId,
      name:        d.DiskName || d.DiskId,
      status:      d.DiskState === "ATTACHED" ? "Running" : d.DiskState,
      spec:        `${d.DiskType || "CBS"} ${d.DiskSize || 0}GB`,
      region,
      diskUsage:   d.DiskUsage, // SYSTEM_DISK / DATA_DISK
      // 只有獨立管理的資料碟（DATA_DISK）才需顯示到期日
      // 系統碟跟 CVM 一起續費，不單獨列入到期總覽
      expireTime:  d.DiskUsage === "DATA_DISK" && d.DiskChargeType === "PREPAID"
        && d.DeadlineTime && !d.DeadlineTime.startsWith("0000")
        ? d.DeadlineTime : null,
      productCode: "cbs",
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

// ── 拉取全產品續費清單（等同阿里雲 QueryAvailableInstances）────
// Billing.DescribeRenewInstances 涵蓋 CVM/CDB/CBS/COS資源包等全產品
async function fetchRenewInstances({ secretId, secretKey, region }) {
  const cacheKey = `tencent:renew:${secretId}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = makeClient(BillingClient, secretId, secretKey, region);
  const list   = [];
  let nextToken;

  try {
    do {
      const params = { MaxResults: 100 };
      if (nextToken) params.NextToken = nextToken;
      const result = await client.DescribeRenewInstances(params);
      const items  = result.InstanceList || [];
      items.forEach(i => {
        if (!i.ExpireTime) return; // 按量付費無到期日
        list.push({
          id:          i.InstanceId,
          name:        i.InstanceName || i.InstanceId,
          status:      i.Status === "NORMAL" ? "Running" : i.Status,
          region:      i.RegionCode || region,
          expireTime:  i.ExpireTime,
          productCode: (i.ProductCode || "").toLowerCase(),
          productName: i.ProductName || i.ProductCode,
          renewFlag:   i.RenewFlag,
        });
      });
      nextToken = result.NextToken || null;
    } while (nextToken);

    logger.info("[TC] DescribeRenewInstances: " + list.length + " 筆");
  } catch (err) {
    logger.warn("[TC] DescribeRenewInstances 失敗: " + err.message);
  }

  const data = { total: list.length, list };
  await redis.setex(cacheKey, 5 * 60, JSON.stringify(data));
  return data;
}

// ── 拉取帳戶餘額 ─────────────────────────────────────────────
// DescribeAccountBalance 返回 Balance（單位：分），除以100得元
async function fetchAccountBalance({ secretId, secretKey }) {
  const cacheKey = `tencent:balance:${secretId}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = makeClient(BillingClient, secretId, secretKey, "ap-guangzhou");
  let data = { availableAmount: null, invoiceAmount: null };

  try {
    const result = await client.DescribeAccountBalance({});
    // RealBalance = 可用餘額（分）；Balance = 帳戶總額（分）
    const fen = result.RealBalance ?? result.Balance ?? null;
    data.availableAmount = fen !== null ? (fen / 100).toFixed(2) : null;
  } catch (err) {
    logger.warn("[TC] DescribeAccountBalance 失敗: " + err.message);
  }

  // DescribeUserInvoiceAmount — SDK 無此 method，用底層 request() 呼叫
  // Source=0 查自研發票；UnInvoiceAmount = 可開票金額（元，字串）
  try {
    const inv = await new Promise((resolve, reject) =>
      client.request("DescribeUserInvoiceAmount", { Source: 0 }, (err, res) =>
        err ? reject(err) : resolve(res)
      )
    );
    const raw = parseFloat(inv.UnInvoiceAmount ?? "0");
    data.invoiceAmount = isNaN(raw) ? null : raw.toFixed(2);
  } catch (err) {
    logger.warn("[TC] DescribeUserInvoiceAmount 失敗: " + err.message);
  }

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
  try {
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

    const [cvm, cdb, cbs, cos, renew, billing, balance, secEvents] = await Promise.allSettled([
      fetchCVM(params),
      fetchCDB(params),
      fetchCBS(params),
      fetchCOS(params),
      fetchRenewInstances(params),   // 涵蓋全產品到期資訊
      fetchBilling(params),
      fetchAccountBalance(params),
      fetchSecurityEvents(params),
    ]);

    const cvmData     = cvm.status     === "fulfilled" ? cvm.value     : { total: 0, list: [] };
    const cdbData     = cdb.status     === "fulfilled" ? cdb.value     : { total: 0, list: [] };
    const cbsData     = cbs.status     === "fulfilled" ? cbs.value     : { total: 0, list: [] };
    const cosData     = cos.status     === "fulfilled" ? cos.value     : { total: 0, list: [] };
    const renewData   = renew.status   === "fulfilled" ? renew.value   : { total: 0, list: [] };
    const billingData = billing.status === "fulfilled" ? billing.value : { currentMonth: 0 };
    const balanceData = balance.status === "fulfilled" ? balance.value : {};
    const secData     = secEvents.status === "fulfilled" ? secEvents.value : [];

    if (cbs.status   === "rejected") logger.warn("[TC] CBS 失敗: " + cbs.reason?.message);
    if (renew.status === "rejected") logger.warn("[TC] DescribeRenewInstances 失敗: " + renew.reason?.message);

    // 訂閱到期彙總：直接用 DescribeRenewInstances 結果（涵蓋全產品）
    const subList = renewData.list;

    await prisma.resourceSnapshot.create({
      data: {
        accountId: account.id,
        ecsCount:  cvmData.total,
        rdsCount:  cdbData.total,
        ossCount:  cosData.total,
        slbCount:  cbsData.total,
        monthCost: billingData.currentMonth,
        rawData: {
          ecs:           cvmData,
          rds:           cdbData,
          cbs:           cbsData,
          oss:           cosData,
          billing:       billingData,
          balance:       balanceData,
          subscriptions: { total: subList.length, list: subList },
        },
      },
    });

    // 安全告警：upsert 防重複（每次 sync 同一事件不重複寫入）
    for (const e of secData) {
      const alertId = `tc-sec-${e.EventId || e.EventName + e.EventTime}`;
      await prisma.alert.upsert({
        where:  { id: alertId },
        create: {
          id:        alertId,
          accountId: account.id,
          level:     "WARNING",
          type:      "SECURITY",
          message:   `高風險操作: ${e.EventName} by ${e.Username || "unknown"}`,
          detail:    e,
        },
        update: {},
      }).catch(err => logger.warn(`[TC] alert upsert 失敗: ${err.message}`));
    }

    // Budget alert — upsert 防每次 sync 重複寫入
    if (account.budgetLimit && billingData.currentMonth > account.budgetLimit * 0.85) {
      const level   = billingData.currentMonth > account.budgetLimit ? "CRITICAL" : "WARNING";
      const alertId = `tc-budget-${account.id}-${new Date().toISOString().slice(0, 7)}`; // 每月唯一
      await prisma.alert.upsert({
        where:  { id: alertId },
        create: {
          id:        alertId,
          accountId: account.id,
          level,
          type:    "BILLING",
          message: `本月費用 ¥${billingData.currentMonth.toFixed(0)} 已達預算 ${((billingData.currentMonth / account.budgetLimit) * 100).toFixed(0)}%`,
        },
        update: { level, message: `本月費用 ¥${billingData.currentMonth.toFixed(0)} 已達預算 ${((billingData.currentMonth / account.budgetLimit) * 100).toFixed(0)}%` },
      }).catch(err => logger.warn(`[TC] billing alert upsert 失敗: ${err.message}`));
    }

    logger.info("[TC] " + account.name + " 同步完成 - CVM:" + cvmData.total + " CDB:" + cdbData.total + " CBS:" + cbsData.total + " COS:" + cosData.total + " 到期:" + subList.length + " 餘額:" + (balanceData.availableAmount ?? "—"));
  } catch (err) {
    logger.error(`[TC] 同步失敗 ${account.name}: ${err.message}`);
  }
}

module.exports = {
  testConnection,
  fetchCVM,
  fetchCDB,
  fetchCBS,
  fetchCOS,
  fetchRenewInstances,
  fetchBilling,
  fetchAccountBalance,
  fetchSecurityEvents,
  syncAccount,
};
