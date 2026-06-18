# 阿里雲 RAM Role 跨帳號授權設定指南

## 架構說明

```
主帳號 (Master) ──AssumeRole──▶ 子帳號 A ReadOnly Role
                               ▶ 子帳號 B ReadOnly Role
                               ▶ 子帳號 C ReadOnly Role
```

## 步驟一：在主帳號建立專用 RAM 用戶

1. 登入主帳號 RAM 控制台
2. 建立 RAM 用戶：`aliyun-ctrl-service`
3. 賦予策略（自訂）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "*"
    }
  ]
}
```

4. 建立 AccessKey，填入後端 `.env`：
   - `ALIYUN_MASTER_ACCESS_KEY_ID`
   - `ALIYUN_MASTER_ACCESS_KEY_SECRET`

---

## 步驟二：在每個子帳號建立 RAM Role

**在每個子帳號（A、B、C...）的 RAM 控制台操作：**

### 2a. 建立角色

- 角色名稱：`AliyunCtrlReadOnly`
- 信任類型：選「阿里雲帳號」
- 填入**主帳號 ID**（UID）

**信任策略（Trust Policy）：**

```json
{
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Effect": "Allow",
      "Principal": {
        "RAM": [
          "acs:ram::<主帳號UID>:root"
        ]
      }
    }
  ],
  "Version": "1"
}
```

### 2b. 附加權限策略

最小只讀權限（推薦）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:Describe*",
        "rds:Describe*",
        "oss:ListBuckets",
        "slb:Describe*",
        "actiontrail:LookupEvents",
        "bss:QueryBill",
        "bss:DescribeResourcePackages",
        "cloudmonitor:Describe*",
        "cloudmonitor:List*"
      ],
      "Resource": "*"
    }
  ]
}
```

### 2c. 取得 Role ARN

建立後在角色詳情頁面可看到：
```
acs:ram::<子帳號UID>:role/AliyunCtrlReadOnly
```

填入平台的「新增帳號」表單的 `roleArn` 欄位。

---

## 步驟三：驗證

在後端調用 test API：

```bash
curl -X POST http://localhost:3001/api/accounts \
  -H "Authorization: Bearer <your-jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "生產環境",
    "alias": "PROD",
    "accountId": "1234567890123456",
    "roleArn": "acs:ram::1234567890123456:role/AliyunCtrlReadOnly",
    "region": "cn-hangzhou",
    "budgetLimit": 50000
  }'
```

---

## 安全建議

| 項目 | 建議 |
|------|------|
| AccessKey 輪換 | 每 90 天輪換一次主帳號 RAM Key |
| STS Token 時效 | 使用 1 小時臨時憑證，不存儲永久 Key |
| 最小權限 | 只開放 `Describe*` / `List*` 唯讀操作 |
| 審計日誌 | 開啟 ActionTrail 記錄所有 API 調用 |
| MFA | 主帳號 RAM 用戶啟用 MFA |
