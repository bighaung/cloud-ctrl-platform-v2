#!/bin/bash
# setup.sh — 一鍵啟動阿里雲多帳號管理平台

set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo -e "${GREEN}🚀 Aliyun CTRL Platform Setup${NC}"

# 1. 複製環境變數
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  echo -e "${YELLOW}⚠️  請編輯 backend/.env 填入阿里雲 RAM Key 和密碼${NC}"
  echo "   nano backend/.env"
  exit 1
fi

# 2. 啟動基礎設施
echo "Starting PostgreSQL and Redis..."
docker compose up -d postgres redis

# 3. 等待資料庫就緒
echo "Waiting for database..."
sleep 5

# 4. 安裝後端依賴 & 資料庫遷移
echo "Setting up backend..."
cd backend
npm install
npx prisma db push
cd ..

# 5. 啟動所有服務
docker compose up -d

echo ""
echo -e "${GREEN}✅ 啟動完成！${NC}"
echo ""
echo "  前端:   http://localhost:3000"
echo "  後端:   http://localhost:3001"
echo "  Health: http://localhost:3001/health"
echo ""
echo "  預設管理員帳號（記得登入後修改密碼）:"
echo "  Email:    \${ADMIN_EMAIL}"
echo "  Password: \${ADMIN_PASSWORD}"
echo ""
echo -e "${YELLOW}📖 RAM Role 設定說明: infra/RAM_SETUP.md${NC}"
