"use strict";
const express    = require("express");
const helmet     = require("helmet");
const cors       = require("cors");
const compression = require("compression");
const rateLimit  = require("express-rate-limit");

const { prisma }  = require("./config/db");
const { redis }   = require("./config/redis");
const logger      = require("./config/logger");
const seedAdmin   = require("./scripts/seed");

// Routes
const authRoutes     = require("./routes/auth");
const accountRoutes  = require("./routes/accounts");
const resourceRoutes = require("./routes/resources");
const alertRoutes    = require("./routes/alerts");
const userRoutes     = require("./routes/users");

const app = express();

// ── Security Middleware ───────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: "1mb" }));

// Rate limiting
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many requests" }));
app.use("/api",      rateLimit({ windowMs: 1  * 60 * 1000, max: 200 }));

// ── Health Check ──────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "error", error: err.message });
  }
});

// ── API Routes ────────────────────────────────────────────────
app.use("/api/auth",      authRoutes);
app.use("/api/accounts",  accountRoutes);
app.use("/api/resources", resourceRoutes);
app.use("/api/alerts",    alertRoutes);
app.use("/api/users",     userRoutes);

// ── Error Handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error({ message: err.message, stack: err.stack, path: req.path });
  const status = err.status || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === "production" ? "Internal Server Error" : err.message,
  });
});

// ── Startup ───────────────────────────────────────────────────
async function start() {
  try {
    await prisma.$connect();
    logger.info("✅ PostgreSQL connected");

    await redis.ping();
    logger.info("✅ Redis connected");

    // Seed default admin on first run
    await seedAdmin();

    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => logger.info(`🚀 API Server running on port ${PORT}`));
  } catch (err) {
    logger.error("Startup failed:", err);
    process.exit(1);
  }
}

start();
