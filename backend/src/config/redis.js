"use strict";
const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  lazyConnect:        true,
  enableReadyCheck:   true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

redis.on("error", (err) => require("../config/logger").error(`Redis error: ${err.message}`));

module.exports = { redis };
