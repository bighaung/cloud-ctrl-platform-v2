#!/bin/bash
# install-linux.sh — Linux 環境一鍵安裝（Ubuntu 20.04/22.04 / CentOS 7/8）
set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo -e "${GREEN}"
echo "╔══════════════════════════════════════╗"
echo "║   雲帳號管理平台 — Linux 安裝腳本    ║"
echo "╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── 偵測 OS ───────────────────────────────────────────────────
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
else
  echo -e "${RED}無法識別作業系統${NC}"; exit 1
fi

# ── 1. 安裝 Docker ────────────────────────────────────────────
echo -e "${GREEN}[1/5] 安裝 Docker...${NC}"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo -e "${GREEN}✅ Docker 安裝完成${NC}"
else
  echo "Docker 已安裝：$(docker --version)"
fi

# ── 2. 安裝 Node.js 20 ────────────────────────────────────────
echo -e "${GREEN}[2/5] 安裝 Node.js 20...${NC}"
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null || \
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - 2>/dev/null
  if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    apt-get install -y nodejs
  else
    yum install -y nodejs
  fi
  echo -e "${GREEN}✅ Node.js $(node -v) 安裝完成${NC}"
else
  echo "Node.js 已安裝：$(node -v)"
fi

# ── 3. 建立目錄 ───────────────────────────────────────────────
echo -e "${GREEN}[3/5] 建立應用目錄...${NC}"
APP_DIR="/opt/cloud-ctrl"
mkdir -p $APP_DIR
cp -r . $APP_DIR/
cd $APP_DIR

# ── 4. 設定環境變數 ───────────────────────────────────────────
echo -e "${GREEN}[4/5] 設定環境變數...${NC}"
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env

  # 自動生成 JWT Secret
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  sed -i "s/replace_with_64_byte_random_hex/$JWT_SECRET/" backend/.env

  echo -e "${YELLOW}"
  echo "⚠️  請編輯以下設定檔，填入密碼和阿里雲/騰訊雲 Key："
  echo "   nano $APP_DIR/backend/.env"
  echo ""
  echo "   必填項目："
  echo "   - DB_PASS          資料庫密碼"
  echo "   - REDIS_PASS       Redis 密碼"
  echo "   - ADMIN_EMAIL      管理員 Email"
  echo "   - ADMIN_PASSWORD   管理員初始密碼"
  echo "   - ALIYUN_MASTER_ACCESS_KEY_ID / SECRET  (阿里雲)"
  echo "   （騰訊雲 Key 透過平台介面新增，無需在此設定）"
  echo -e "${NC}"
  read -p "編輯完成後按 Enter 繼續..."
fi

# ── 5. 啟動服務 ───────────────────────────────────────────────
echo -e "${GREEN}[5/5] 啟動服務...${NC}"

# 啟動 PostgreSQL + Redis
docker compose up -d postgres redis
echo "等待資料庫就緒..."
sleep 8

# 後端依賴安裝 + DB 初始化
cd backend
npm install --production
npx prisma db push
cd ..

# 用 systemd 管理後端進程
cat > /etc/systemd/system/cloud-ctrl.service << SVCEOF
[Unit]
Description=Cloud Control Backend
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR/backend
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable cloud-ctrl
systemctl start cloud-ctrl

sleep 3

# ── 完成 ─────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗"
echo "║          ✅ 安裝完成！               ║"
echo "╚══════════════════════════════════════╝${NC}"
echo ""
echo "  API 健康檢查："
curl -s http://localhost:3001/health | python3 -m json.tool 2>/dev/null || \
  echo "  → http://localhost:3001/health"
echo ""
echo "  管理指令："
echo "  systemctl status cloud-ctrl    # 查看狀態"
echo "  journalctl -u cloud-ctrl -f    # 查看 log"
echo "  systemctl restart cloud-ctrl   # 重啟"
echo ""
echo -e "${YELLOW}📖 阿里雲 RAM 設定：$APP_DIR/infra/RAM_SETUP.md"
echo "📖 騰訊雲設定：    $APP_DIR/infra/TENCENT_SETUP.md${NC}"
