"use strict";
/**
 * aliyunService — 核心阿里雲 API 整合層
 *
 * 使用主帳號 RAM Key 做 STS AssumeRole，取得子帳號臨時憑證後
 * 呼叫各服務 API，結果快取到 Redis。
 */

const Core   = require("@alicloud/pop-core");
const crypto = require("crypto");
const https  = require("https");
const { redis }  = require("../config/redis");
const { prisma } = require("../config/db");
const logger = require("../config/logger");

// ── STS Client（主帳號）─────────────────────────────────────
function getStsClient() {
  return new Core({
    accessKeyId:     process.env.ALIYUN_MASTER_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_MASTER_ACCESS_KEY_SECRET,
    endpoint:        "https://sts.aliyuncs.com",
    apiVersion:      "2015-04-01",
  });
}

// ── AssumeRole → 取得臨時憑證 ────────────────────────────────
async function assumeRole(roleArn) {
  const cacheKey = `sts:${roleArn}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sts = getStsClient();
  const result = await sts.request("AssumeRole", {
    RoleArn:         roleArn,
    RoleSessionName: "AliyunCtrlDashboard",
    DurationSeconds: 3600,
  });

  const creds = result.Credentials;
  // Cache 55 min（比 1h 到期早 5 min）
  await redis.setex(cacheKey, 55 * 60, JSON.stringify(creds));
  return creds;
}

// ── 建立帶臨時憑證的 Client ───────────────────────────────────
async function getClient(roleArn, endpoint, apiVersion) {
  const creds = await assumeRole(roleArn);
  return new Core({
    accessKeyId:     creds.AccessKeyId,
    accessKeySecret: creds.AccessKeySecret,
    securityToken:   creds.SecurityToken,
    endpoint,
    apiVersion,
  });
}

// ── 測試連線 ──────────────────────────────────────────────────
async function testConnection(roleArn, region) {
  try {
    const client = await getClient(
      roleArn,
      `https://ecs.${region}.aliyuncs.com`,
      "2014-05-26"
    );
    await client.request("DescribeRegions", {});
    return { ok: true };
  } catch (err) {
    logger.warn(`Connection test failed for ${roleArn}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── 拉取 ECS 資源 ─────────────────────────────────────────────
async function fetchECS(roleArn, region) {
  const cacheKey = `ecs:${roleArn}:${region}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = await getClient(
    roleArn,
    `https://ecs.${region}.aliyuncs.com`,
    "2014-05-26"
  );
  const result = await client.request("DescribeInstances", {
    RegionId:   region,
    PageSize:   100,
  });

  const rawInst   = result.Instances?.Instance;
  const instances = Array.isArray(rawInst) ? rawInst : (rawInst ? [rawInst] : []);
  const data = {
    total:   result.TotalCount || 0,
    running: instances.filter(i => i.Status === "Running").length,
    stopped: instances.filter(i => i.Status === "Stopped").length,
    list:    instances.map(i => ({
      id:         i.InstanceId,
      name:       i.InstanceName,
      status:     i.Status,
      cpu:        i.Cpu,
      memory:     i.Memory,
      publicIp:   i.PublicIpAddress?.IpAddress?.[0],
      privateIp:  i.VpcAttributes?.PrivateIpAddress?.IpAddress?.[0],
      expireTime: i.ExpiredTime,
    })),
  };

  await redis.setex(cacheKey, 5 * 60, JSON.stringify(data)); // 5 min cache
  return data;
}

// ── 拉取 RDS 資源 ─────────────────────────────────────────────
async function fetchRDS(roleArn, region) {
  const cacheKey = `rds:${roleArn}:${region}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = await getClient(
    roleArn,
    `https://rds.aliyuncs.com`,
    "2014-08-15"
  );
  let result;
  try {
    result = await client.request("DescribeDBInstances", {
      RegionId: region,
      PageSize: 100,
    });
  } catch (err) {
    logger.error(`fetchRDS API error: ${err.message}`);
    throw err;
  }

  const raw   = result.Items?.DBInstance;
  const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const data  = { total: items.length || result.TotalRecordCount || 0, list: items };

  if (data.total > 0) {
    await redis.setex(cacheKey, 5 * 60, JSON.stringify(data));
  }
  return data;
}

// ── 拉取 OSS Bucket 數（直接呼叫 OSS REST API）─────────────────
async function fetchOSS(roleArn) {
  const cacheKey = `oss:${roleArn}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const creds  = await assumeRole(roleArn);

  const xml = await new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const stringToSign = [
      "GET", "", "", date,
      `x-oss-security-token:${creds.SecurityToken}`,
      "/",
    ].join("\n");
    const sig = crypto.createHmac("sha1", creds.AccessKeySecret)
      .update(stringToSign).digest("base64");

    const req = https.request({
      hostname: "oss.aliyuncs.com",
      path:     "/",
      method:   "GET",
      headers: {
        Date:                   date,
        Authorization:          `OSS ${creds.AccessKeyId}:${sig}`,
        "x-oss-security-token": creds.SecurityToken,
      },
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => resolve(buf));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(new Error("OSS request timeout")); });
    req.end();
  });

  // 從 XML 解析 bucket 名稱（不依賴外部 parser）
  const count = (xml.match(/<Bucket>/g) || []).length;
  const names = [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
  const data  = { total: count, list: names.map(n => ({ name: n })) };

  if (data.total > 0) {
    await redis.setex(cacheKey, 10 * 60, JSON.stringify(data));
  }
  logger.info(`fetchOSS: ${count} buckets for ${roleArn}`);
  return data;
}

// ── 拉取所有包年包月訂閱（含到期日）─────────────────────────────
// QueryAvailableInstances 不指定 ProductCode 只回傳部分類型；
// 對已知會漏的產品再補一次查詢，最後合併去重。
async function fetchSubscriptions(roleArn) {
  const cacheKey = `subscriptions:${roleArn}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = await getClient(roleArn, "https://business.aliyuncs.com", "2017-12-14");

  // 查一個 product code 的所有分頁
  async function queryProduct(productCode) {
    const items = [];
    let pageNum = 1;
    while (true) {
      const params = { PageNum: pageNum, PageSize: 100 };
      if (productCode) params.ProductCode = productCode;
      let result;
      try {
        result = await client.request("QueryAvailableInstances", params);
      } catch (e) {
        logger.warn(`fetchSubscriptions ${productCode || "all"}: ${e.message}`);
        break;
      }
      // InstanceList 本身就是陣列（無 .Instance 包裝層）
      const raw = result.Data?.InstanceList;
      const batch = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      items.push(...batch);
      const total = result.Data?.TotalCount || 0;
      if (items.length >= total || batch.length === 0) break;
      pageNum++;
      if (pageNum > 5) {
        logger.warn(`[subscriptions] 翻頁超過上限 5 頁，已截斷 (${productCode || "all"})，目前 ${items.length} 筆`);
        break;
      }
    }
    return items;
  }

  // 先拉全量，再補查可能漏掉的產品類型
  const EXTRA_CODES = ["kvstore", "redisa", "eip", "sas", "cloud_siem", "aegis", "alimail", "directmail"];
  const results = await Promise.all([
    queryProduct(null),
    ...EXTRA_CODES.map(c => queryProduct(c)),
  ]);
  const [allRaw, ...extraRaw] = results;

  // DEBUG：印出每個 code 的結果數
  logger.info(`[subscriptions] all(no filter): ${allRaw.length}`);
  EXTRA_CODES.forEach((code, i) => {
    logger.info(`[subscriptions] ProductCode=${code}: ${extraRaw[i].length}`);
  });

  // 合併去重（以 InstanceID 為 key）
  const seen = new Map();
  for (const item of [...allRaw, ...extraRaw.flat()]) {
    if (item.InstanceID && !seen.has(item.InstanceID)) {
      seen.set(item.InstanceID, item);
    }
  }
  const allInstances = [...seen.values()];
  logger.info(`[subscriptions] merged total: ${allInstances.length} | keys: ${allInstances.map(i=>i.ProductCode).join(",")}`);

  const data = {
    total: allInstances.length,
    list:  allInstances.map(i => ({
      id:          i.InstanceID,
      productCode: i.ProductCode,
      productType: i.ProductType,
      status:      i.Status,
      region:      i.Region,
      // 2999-09-09 是阿里雲「無固定到期日」的佔位符，視同無到期日
      expireTime:  (i.EndTime && !i.EndTime.startsWith("2999")) ? i.EndTime : null,
      createTime:  i.CreateTime,
    })),
  };

  if (data.total > 0) {
    await redis.setex(cacheKey, 10 * 60, JSON.stringify(data));
  }
  logger.info(`fetchSubscriptions: ${data.total} instances for ${roleArn}`);
  return data;
}

// ── 拉取費用（本月）─────────────────────────────────────────
async function fetchBilling(roleArn) {
  const cacheKey = `billing:${roleArn}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = await getClient(
    roleArn,
    "https://business.aliyuncs.com",
    "2017-12-14"
  );

  const now  = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, "0");

  const result = await client.request("QueryBill", {
    BillingCycle: `${yyyy}-${mm}`,
    Type:         "PostPaid",
    PageNum:      1,
    PageSize:     100,
  });

  // Also get last month for comparison
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lyyyy     = lastMonth.getFullYear();
  const lmm       = String(lastMonth.getMonth() + 1).padStart(2, "0");

  const lastResult = await client.request("QueryBill", {
    BillingCycle: `${lyyyy}-${lmm}`,
    Type:         "PostPaid",
    PageNum:      1,
    PageSize:     100,
  });

  const thisMonthTotal = parseFloat(result.Data?.BillAccountSummary?.[0]?.PaymentAmount || 0);
  const lastMonthTotal = parseFloat(lastResult.Data?.BillAccountSummary?.[0]?.PaymentAmount || 0);

  // Breakdown by product
  const items     = result.Data?.Items?.Item || [];
  const breakdown = {};
  for (const item of items) {
    const key = item.ProductCode;
    breakdown[key] = (breakdown[key] || 0) + parseFloat(item.PretaxAmount || 0);
  }

  const data = {
    currentMonth: thisMonthTotal,
    lastMonth:    lastMonthTotal,
    trend:        lastMonthTotal > 0 ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal * 100).toFixed(1) : 0,
    breakdown,
    billingCycle: `${yyyy}-${mm}`,
  };

  await redis.setex(cacheKey, 30 * 60, JSON.stringify(data)); // 30 min cache
  return data;
}

// ── 拉取帳戶餘額 & 可開票金額 ─────────────────────────────────
async function fetchAccountBalance(roleArn) {
  const cacheKey = `balance:${roleArn}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = await getClient(roleArn, "https://business.aliyuncs.com", "2017-12-14");

  let bal = null;
  try {
    const balResult = await client.request("QueryAccountBalance", {});
    logger.info("[ALI] QueryAccountBalance OK: " + roleArn.split("/").pop());
    bal = balResult?.Data ?? null;
  } catch (err) {
    logger.warn("[ALI] QueryAccountBalance 失敗 (" + roleArn.split("/").pop() + "): " + err.message);
  }

  // Aliyun 金額字串帶千位逗號（如 "1,266.75"），需先去除再解析
  const parseNum = v => {
    if (v == null) return null;
    const n = Number(String(v).replace(/,/g, ""));
    return !isNaN(n) ? n.toFixed(2) : null;
  };

  // 可開票金額：QueryEvaluateList，TotalUnAppliedInvoiceAmount 單位為分
  let invoiceFen = null;
  try {
    const invResult = await client.request("QueryEvaluateList", { Type: 2, PageSize: 1 });
    invoiceFen = invResult?.Data?.TotalUnAppliedInvoiceAmount ?? null;
    logger.info("[ALI] QueryEvaluateList OK: " + roleArn.split("/").pop());
  } catch (err) {
    logger.warn("[ALI] QueryEvaluateList 失敗 (" + roleArn.split("/").pop() + "): " + err.message);
  }

  const data = {
    availableAmount: parseNum(bal?.AvailableAmount ?? bal?.AvailableCashAmount),
    creditAmount:    parseNum(bal?.CreditAmount),
    invoiceAmount:   invoiceFen !== null ? (invoiceFen / 100).toFixed(2) : null,
  };

  logger.info(`[ALI] balance ${roleArn.split('/').pop()} — 餘額:${data.availableAmount}`);

  await redis.setex(cacheKey, 10 * 60, JSON.stringify(data));
  return data;
}

// ── 拉取 Redis/Tair 實例 ──────────────────────────────────────
async function fetchRedis(roleArn, region) {
  const cacheKey = `kvstore:${roleArn}:${region}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = await getClient(roleArn, `https://r.aliyuncs.com`, "2015-01-01");
  let result;
  try {
    // 不帶 RegionId 可列出所有地域的 Redis 實例
    result = await client.request("DescribeInstances", { PageSize: 100 });
  } catch (err) {
    logger.warn(`fetchRedis all-region failed, retrying with region: ${err.message}`);
    try {
      result = await client.request("DescribeInstances", { RegionId: region, PageSize: 100 });
    } catch (err2) {
      logger.error(`fetchRedis API error: ${err2.message}`);
      throw err2;
    }
  }

  const raw       = result.Instances?.KVStoreInstance;
  const instances = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const data = {
    total: instances.length,
    list: instances.map(i => ({
      id:         i.InstanceId,
      name:       i.InstanceName || i.InstanceId,
      type:       i.InstanceClass,
      engine:     i.InstanceType,   // Redis / Memcache / Tair
      status:     i.InstanceStatus,
      expireTime: i.EndTime || null,
    })),
  };

  if (data.total > 0) {
    await redis.setex(cacheKey, 5 * 60, JSON.stringify(data));
  }
  return data;
}

// ── 拉取彈性公網 IP（僅包年包月）────────────────────────────────
async function fetchEIP(roleArn, region) {
  const cacheKey = `eip:${roleArn}:${region}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = await getClient(
    roleArn, `https://ecs.${region}.aliyuncs.com`, "2014-05-26"
  );
  let result;
  try {
    // 先嘗試只拉包年包月（有到期日）
    result = await client.request("DescribeEipAddresses", {
      RegionId:   region,
      PageSize:   100,
      ChargeType: "PrePaid",
    });
  } catch (err) {
    logger.warn(`fetchEIP PrePaid filter failed, fetching all EIPs: ${err.message}`);
    try {
      result = await client.request("DescribeEipAddresses", { RegionId: region, PageSize: 100 });
    } catch (err2) {
      logger.error(`fetchEIP API error: ${err2.message}`);
      throw err2;
    }
  }

  const raw   = result.EipAddresses?.EipAddress;
  const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const data  = {
    total: items.length,
    list: items.map(e => ({
      id:         e.AllocationId,
      name:       e.Name || e.IpAddress,
      ip:         e.IpAddress,
      status:     e.Status,
      expireTime: e.ExpiredTime || null,
    })).filter(e => e.expireTime), // 只留有到期日的（包年包月才有）
  };
  data.total = data.list.length;

  if (data.total > 0) {
    await redis.setex(cacheKey, 5 * 60, JSON.stringify(data));
  }
  return data;
}

// ── 拉取安全告警（ActionTrail 異常事件）────────────────────────
async function fetchSecurityAlerts(roleArn, region) {
  const cacheKey = `security:${roleArn}:${region}`;
  const cached   = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const client = await getClient(
    roleArn,
    `https://actiontrail.${region}.aliyuncs.com`,
    "2020-07-06"
  );

  // Look for high-risk events in last 24h
  const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result    = await client.request("LookupEvents", {
    StartTime: startTime,
    MaxResults: 50,
  });

  const HIGH_RISK_EVENTS = [
    "DeleteAccessKey", "CreateAccessKey", "UpdateLoginProfile",
    "AttachPolicyToUser", "CreateUser", "DeleteUser",
    "AssumeRoleWithSAML", "GetSecurityPreference",
  ];

  const events  = result.Events || [];
  const risky   = events.filter(e => HIGH_RISK_EVENTS.includes(e.EventName));

  await redis.setex(cacheKey, 5 * 60, JSON.stringify(risky));
  return risky;
}

// ── 完整帳號同步（寫入 DB）────────────────────────────────────
async function syncAccount(account) {
  logger.info(`Syncing account: ${account.name} (${account.accountId})`);
  try {
    // 預熱 STS 憑證：先取一次讓 token 進快取，避免後續並行 fetch 同時打 STS 造成 throttle
    try {
      await assumeRole(account.roleArn);
      logger.info(`STS pre-warmed for ${account.name}`);
    } catch (stsErr) {
      logger.error(`STS pre-warm failed for ${account.name}: ${stsErr.message}`);
      throw stsErr;
    }

    const [ecs, rds, oss, kvstore, eip, subs, billing, balance, secAlerts] = await Promise.allSettled([
      fetchECS(account.roleArn, account.region),
      fetchRDS(account.roleArn, account.region),
      fetchOSS(account.roleArn),
      fetchRedis(account.roleArn, account.region),
      fetchEIP(account.roleArn, account.region),
      fetchSubscriptions(account.roleArn),
      fetchBilling(account.roleArn),
      fetchAccountBalance(account.roleArn),
      fetchSecurityAlerts(account.roleArn, account.region),
    ]);

    const ecsData     = ecs.status     === "fulfilled" ? ecs.value     : { total: 0, list: [] };
    const rdsData     = rds.status     === "fulfilled" ? rds.value     : { total: 0, list: [] };
    const ossData     = oss.status     === "fulfilled" ? oss.value     : { total: 0, list: [] };
    const kvData      = kvstore.status === "fulfilled" ? kvstore.value : { total: 0, list: [] };
    const eipData     = eip.status     === "fulfilled" ? eip.value     : { total: 0, list: [] };
    const subsData    = subs.status    === "fulfilled" ? subs.value    : { total: 0, list: [] };
    const billingData = billing.status === "fulfilled" ? billing.value : { currentMonth: 0 };
    const balanceData = balance.status === "fulfilled" ? balance.value : {};
    const secData     = secAlerts.status === "fulfilled" ? secAlerts.value : [];

    // ── 聚合到期資料：BSS subscriptions + kvstore + eip ──────────
    // 各 fetcher 失敗時已退回空陣列，這裡統一補進來避免遺漏
    const expiryMap = new Map();
    // 1. BSS subscriptions（含 ECS/RDS，可能含 Redis/EIP/SAS/AliMail）
    (subsData.list || []).forEach(s => expiryMap.set(s.id, s));
    // 2. Redis/KVStore（BSS 未涵蓋時補充）
    (kvData.list || []).filter(k => k.expireTime).forEach(k => {
      if (!expiryMap.has(k.id)) {
        expiryMap.set(k.id, {
          id: k.id, productCode: "redisa", productType: "",
          status: k.status, region: account.region,
          expireTime: k.expireTime, createTime: null,
        });
      }
    });
    // 3. EIP（BSS 未涵蓋時補充）
    (eipData.list || []).filter(e => e.expireTime).forEach(e => {
      if (!expiryMap.has(e.id)) {
        expiryMap.set(e.id, {
          id: e.id, productCode: "eip", productType: "",
          status: e.status, region: account.region,
          expireTime: e.expireTime, createTime: null,
        });
      }
    });
    const mergedSubs = { total: expiryMap.size, list: [...expiryMap.values()] };
    logger.info(`[syncAccount:${account.name}] BSS=${subsData.total} kv=${kvData.total} eip=${eipData.total} merged=${mergedSubs.total}`);

    // Save snapshot
    await prisma.resourceSnapshot.create({
      data: {
        accountId: account.id,
        ecsCount:  ecsData.total,
        rdsCount:  rdsData.total,
        ossCount:  ossData.total,
        slbCount:  0,
        monthCost: billingData.currentMonth,
        rawData:   { ecs: ecsData, rds: rdsData, oss: ossData, kvstore: kvData, eip: eipData, subscriptions: mergedSubs, billing: billingData, balance: balanceData },
      },
    });

    // Auto-create security alerts for risky events
    for (const event of secData) {
      await prisma.alert.upsert({
        where: { id: `sec-${event.EventId}` },
        create: {
          id:        `sec-${event.EventId}`,
          accountId: account.id,
          level:     "WARNING",
          type:      "SECURITY",
          message:   `高風險操作: ${event.EventName} by ${event.UserIdentity?.UserName || "unknown"}`,
          detail:    event,
        },
        update: {},
      }).catch(e => logger.warn(`[ALI] alert upsert 失敗: ${e.message}`));
    }

    // Budget alert
    if (account.budgetLimit && billingData.currentMonth > account.budgetLimit * 0.85) {
      const level = billingData.currentMonth > account.budgetLimit ? "CRITICAL" : "WARNING";
      await prisma.alert.create({
        data: {
          accountId: account.id,
          level,
          type:      "BILLING",
          message:   `本月費用 ¥${billingData.currentMonth.toFixed(0)} 已達預算 ${((billingData.currentMonth / account.budgetLimit) * 100).toFixed(0)}%`,
        },
      }).catch(() => {});
    }

    logger.info(`Sync complete: ${account.name}`);
  } catch (err) {
    logger.error(`Sync failed for ${account.name}: ${err.message}`);
  }
}

module.exports = {
  testConnection,
  fetchECS,
  fetchRDS,
  fetchOSS,
  fetchRedis,
  fetchEIP,
  fetchSubscriptions,
  fetchBilling,
  fetchAccountBalance,
  fetchSecurityAlerts,
  syncAccount,
};
