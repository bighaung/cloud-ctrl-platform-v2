# Linux 部署指南（Ubuntu 20.04 / 22.04，無 Docker，內網）

> 所有指令在 Linux 機器上以 SSH 執行。

---

## 第一步：安裝系統依賴

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL 16
sudo apt install -y postgresql postgresql-contrib

# Redis 7
sudo apt install -y redis-server

# 確認版本
node -v        # 應顯示 v20.x.x
psql --version # 應顯示 16.x
redis-cli --version
```

---

## 第二步：設定 PostgreSQL

```bash
# 進入 postgres 超級用戶
sudo -u postgres psql

-- 在 psql 互動介面執行以下三行：
CREATE USER admin WITH PASSWORD '你的DB密碼';
CREATE DATABASE aliyun_ctrl OWNER admin;
GRANT ALL PRIVILEGES ON DATABASE aliyun_ctrl TO admin;
\q
```

確認可以連線：
```bash
psql -U admin -d aliyun_ctrl -h localhost
# 輸入密碼後進入 psql 表示成功，\q 退出
```

---

## 第三步：設定 Redis

```bash
sudo nano /etc/redis/redis.conf
```

找到以下兩行並修改（Ctrl+W 搜尋）：

```
# 找到 requirepass 那行，取消註解並設定密碼
requirepass 你的Redis密碼

# 找到 bind 那行，改成只監聽本機
bind 127.0.0.1
```

儲存後重啟：
```bash
sudo systemctl restart redis-server
sudo systemctl enable redis-server

# 確認連線
redis-cli -a 你的Redis密碼 ping
# 應回應 PONG
```

---

## 第四步：上傳專案到 Linux 機器

**方式 A：從你的 Windows 電腦用 scp 上傳**（在 Windows PowerShell 執行）

```powershell
scp -r "C:\Users\via\Documents\Claude\Projects\cloud-ctrl-platform-v2\backend" 用戶名@機器IP:/opt/cloud-ctrl
```

**方式 B：在 Linux 機器上用 git clone**（如果代碼在 git）

```bash
sudo mkdir -p /opt/cloud-ctrl
sudo chown $USER:$USER /opt/cloud-ctrl
git clone 你的git倉庫 /opt/cloud-ctrl
```

**方式 C：手動建立目錄後用 SFTP 工具（FileZilla/WinSCP）上傳**

目標路徑：`/opt/cloud-ctrl/backend/`

---

## 第五步：設定環境變數

```bash
cd /opt/cloud-ctrl/backend
cp .env.example .env
nano .env
```

填入以下內容（替換成實際值）：

```dotenv
# ── Database ──────────────────────────────────────────────────
DB_USER=admin
DB_PASS=你的DB密碼
DATABASE_URL=postgresql://admin:你的DB密碼@localhost:5432/aliyun_ctrl

# ── Redis ─────────────────────────────────────────────────────
REDIS_PASS=你的Redis密碼
REDIS_URL=redis://:你的Redis密碼@localhost:6379

# ── JWT Auth ───────────────────────────────────────────────────
# 用以下指令生成：
# node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=貼上生成的隨機值
JWT_EXPIRES_IN=8h

# ── Aliyun 主帳號 RAM ──────────────────────────────────────────
ALIYUN_MASTER_ACCESS_KEY_ID=LTAI5t...
ALIYUN_MASTER_ACCESS_KEY_SECRET=你的SecretKey

# ── App ───────────────────────────────────────────────────────
PORT=3001
NODE_ENV=production
FRONTEND_URL=http://機器IP:3000
```

生成 JWT Secret：
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# 複製輸出值貼入 .env 的 JWT_SECRET
```

---

## 第六步：安裝依賴與建立資料表

```bash
cd /opt/cloud-ctrl/backend

# 安裝 Node 套件
npm install --production

# 建立資料表
npx prisma db push

# 建立初始管理員帳號（自動從 .env 的 ADMIN_EMAIL/ADMIN_PASSWORD 建立）
node src/scripts/seed.js
```

---

## 第七步：用 PM2 持久化運行後端

PM2 是 Node.js 的進程管理器，讓後端在背景持續運行，並在機器重開機後自動重啟。

```bash
# 安裝 PM2
sudo npm install -g pm2

# 啟動後端
cd /opt/cloud-ctrl/backend
pm2 start src/index.js --name cloud-ctrl-api

# 設定開機自動啟動
pm2 startup
# 照著輸出的指令執行（sudo env PATH=...）
pm2 save

# 查看運行狀態
pm2 status
pm2 logs cloud-ctrl-api
```

---

## 第八步：放置前端靜態檔案

```bash
# 建立前端目錄
sudo mkdir -p /var/www/cloud-ctrl

# 從 Windows 上傳前端 HTML（在 Windows PowerShell）：
scp "C:\Users\via\Documents\Claude\Projects\cloud-ctrl-platform-v2\dashboard.html" 用戶名@機器IP:/var/www/cloud-ctrl/index.html
```

用 Python 快速起一個靜態 HTTP Server（臨時測試用）：
```bash
cd /var/www/cloud-ctrl
python3 -m http.server 3000
```

---

## 第九步：確認服務正常

```bash
# 確認後端健康
curl http://localhost:3001/health
# 應回應：{"status":"ok","timestamp":"..."}

# 確認 PostgreSQL
systemctl status postgresql

# 確認 Redis
systemctl status redis-server

# 確認 PM2
pm2 status
```

---

## 常用維護指令

```bash
# 查看後端 log
pm2 logs cloud-ctrl-api --lines 100

# 重啟後端
pm2 restart cloud-ctrl-api

# 停止後端
pm2 stop cloud-ctrl-api

# 更新代碼後重部署
cd /opt/cloud-ctrl/backend
git pull          # 如果用 git
npm install
npx prisma db push
pm2 restart cloud-ctrl-api
```

---

## 開機服務順序確認

重開機後應自動啟動：`postgresql` → `redis-server` → `pm2`（帶 cloud-ctrl-api）

```bash
sudo systemctl enable postgresql
sudo systemctl enable redis-server
# pm2 startup 已處理 PM2 開機啟動
```

---

## 問題排查

| 症狀 | 檢查指令 |
|------|---------|
| 後端無回應 | `pm2 logs cloud-ctrl-api` |
| DB 連線失敗 | `psql -U admin -d aliyun_ctrl -h localhost` |
| Redis 連線失敗 | `redis-cli -a 密碼 ping` |
| Port 被占用 | `sudo lsof -i :3001` |
| 權限問題 | `sudo chown -R $USER:$USER /opt/cloud-ctrl` |
