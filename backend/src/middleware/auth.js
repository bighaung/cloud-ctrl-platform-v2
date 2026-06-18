"use strict";
const jwt   = require("jsonwebtoken");
const { redis } = require("../config/redis");

// ── JWT 驗證 ──────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "未登入" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Check blacklist
    const blacklisted = await redis.get(`blacklist:${token}`);
    if (blacklisted) return res.status(401).json({ error: "Token 已失效，請重新登入" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "登入已過期，請重新登入" });
    }
    return res.status(401).json({ error: "無效的認證" });
  }
}

// ── RBAC 角色控制 ─────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return res.status(403).json({ error: "權限不足" });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
