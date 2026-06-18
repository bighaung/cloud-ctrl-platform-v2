# 騰訊雲子帳號授權設定指南

## 架構說明

```
主帳號（Root）
  ├── 子帳號 A（生產）→ SecretId/Key A
  ├── 子帳號 B（測試）→ SecretId/Key B
  └── 子帳號 C（海外）→ SecretId/Key C
```

騰訊雲子帳號不需要 AssumeRole，每個子帳號直接使用自己的 SecretId/Key 調用 API。

---

## 步驟一：為每個子帳號建立 API 金鑰

1. 用**子帳號**登入騰訊雲控制台
2. 前往「訪問管理 CAM」→「API 密鑰管理」
3. 點「新建密鑰」→ 記錄 SecretId 和 SecretKey

---

## 步驟二：確認子帳號權限

子帳號需要有以下只讀權限（在主帳號 CAM 授權）：

```
QcloudCVMReadOnlyAccess      雲主機只讀
QcloudCDBReadOnlyAccess      雲數據庫只讀
QcloudCOSReadOnlyAccess      對象存儲只讀
QcloudFinanceFullAccess      費用查詢（需主帳號授權）
QcloudAuditReadOnlyAccess    云審計只讀
```

---

## 步驟三：填入平台

透過平台 API 新增帳號：

```bash
curl -X POST http://localhost:3001/api/cloud-accounts \
  -H "Authorization: Bearer <your-jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "TENCENT",
    "name": "騰訊生產環境",
    "alias": "TX-PROD",
    "region": "ap-guangzhou",
    "color": "#4a9eff",
    "budgetLimit": 30000,
    "tencentAppId": "1234567890",
    "secretId": "AKIDxxxxxxxxxxxxxxxx",
    "secretKey": "xxxxxxxxxxxxxxxxxxxxxxxx"
  }'
```

SecretKey 會在後端 **AES-256-GCM 加密**後存入資料庫，不以明文保存。

---

## 支援的地域代碼

| 地域 | 代碼 |
|------|------|
| 廣州 | ap-guangzhou |
| 上海 | ap-shanghai |
| 北京 | ap-beijing |
| 成都 | ap-chengdu |
| 香港 | ap-hongkong |
| 新加坡 | ap-singapore |

---

## 安全建議

| 項目 | 建議 |
|------|------|
| 子帳號 Key 輪換 | 每 90 天輪換 |
| 最小權限 | 只授予 ReadOnly 相關策略 |
| MFA | 子帳號登入啟用 MFA |
| 費用 Key 隔離 | 費用查詢建議用獨立子帳號 |
