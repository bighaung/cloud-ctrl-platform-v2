"use strict";
// src/scripts/seed.js
const bcrypt = require("bcryptjs");
const { prisma } = require("../config/db");
const logger = require("../config/logger");

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || "admin@example.com";
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return;

  // production 環境必須明確設定 ADMIN_PASSWORD，拒絕使用預設弱密碼
  if (process.env.NODE_ENV === "production" && !process.env.ADMIN_PASSWORD) {
    throw new Error("production 環境必須設定 ADMIN_PASSWORD 環境變數，拒絕使用預設密碼啟動");
  }

  const password     = process.env.ADMIN_PASSWORD || "Admin@123456";
  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: "系統管理員",
      role: "ADMIN",
    },
  });

  logger.info(`✅ Default admin created: ${email}`);
  if (!process.env.ADMIN_PASSWORD) {
    logger.warn("⚠️  ADMIN_PASSWORD 未設定，使用預設密碼！請立即登入後修改密碼！");
  }
}

module.exports = seedAdmin;
