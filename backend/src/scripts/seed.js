"use strict";
// src/scripts/seed.js
const bcrypt = require("bcryptjs");
const { prisma } = require("../config/db");
const logger = require("../config/logger");

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || "admin@example.com";
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return;

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
  logger.warn(`⚠️  Please change the default password immediately!`);
}

module.exports = seedAdmin;
