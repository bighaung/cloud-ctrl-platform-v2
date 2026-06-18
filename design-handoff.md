# Design Handoff: 多雲帳號管理 Dashboard

## Overview

用戶用這個頁面一眼看清所有雲帳號的健康狀況、費用與資源數量。  
核心目標：**阿里雲 / 騰訊雲帳號明確分欄，關鍵指標無需點擊即可讀取。**

---

## Layout

頁面分三層：

```
┌─────────────────────────────────────────────┐
│  Summary Bar（總帳號數 / 本月費用 / 活躍告警）      │
├────────────────────┬────────────────────────┤
│  阿里雲 column     │  騰訊雲 column          │
│  ─ account card    │  ─ account card         │
│  ─ account card    │  ─ account card         │
│  [+ 新增按鈕]      │  [+ 新增按鈕]           │
└────────────────────┴────────────────────────┘
```

| Breakpoint | 行為 |
|-----------|------|
| Desktop ≥ 768px | 雙欄並排 `grid-template-columns: 1fr 1fr` |
| Mobile < 768px | 單欄，阿里雲在上，騰訊雲在下 |

---

## Design Tokens

| Token | Value | 用途 |
|-------|-------|------|
| `--ali-accent` | #EF9F27 | 阿里雲帳號卡左側色條 |
| `--ali-badge-bg` | #FAEEDA | 阿里雲 provider badge 背景 |
| `--ali-badge-text` | #633806 | 阿里雲 provider badge 文字 |
| `--tc-accent` | #378ADD | 騰訊雲帳號卡左側色條 |
| `--tc-badge-bg` | #E6F1FB | 騰訊雲 provider badge 背景 |
| `--tc-badge-text` | #0C447C | 騰訊雲 provider badge 文字 |
| `--color-text-danger` | CSS var | 告警數字、告警 badge |
| `--color-background-secondary` | CSS var | Metric card 背景 |
| `--border-radius-lg` | 12px | 帳號卡圓角 |
| `--border-radius-md` | 8px | chip、badge 圓角 |
| spacing-internal | 8px / 12px / 14px | 卡片內部間距 |

---

## Components

### Summary Bar

3 欄等寬 metric cards，`gap: 10px`。

| 欄位 | Label | Value 來源 | 備註 |
|-----|-------|-----------|------|
| 1 | 總帳號數 | `CloudAccount.count` | 整數 |
| 2 | 本月總費用 | `sum(ResourceSnapshot.monthCost)` | `¥X,XXX` 格式 |
| 3 | 活躍告警 | `Alert.count where isResolved=false` | 有值時用 `--color-text-danger` |

**Empty state**（無帳號）：費用顯示 `¥0`，告警顯示 `0`（灰色，非紅色）。

---

### Provider Column Header

```
[provider badge icon + 名稱]        [N 個帳號]
─────────────────────────────────────────────
```

- Badge: 圓角 pill，amber 系（阿里雲）/ blue 系（騰訊雲）
- 分隔線：`border-bottom: 0.5px solid var(--color-border-tertiary)`
- 帳號數：右對齊，12px muted

---

### Account Card

```
┌──────────────────────────────────────────┐
│ ▌  帳號顯示名稱           [告警 badge]   │  ← 色條 3px
│    alias · region                        │
│                                          │
│  [ECS 12] [RDS 4] [OSS 8]               │
│                                          │
│ ¥6,240 / 月              ↻ 3 分鐘前     │
└──────────────────────────────────────────┘
```

**規格：**

| 元素 | 規格 |
|-----|------|
| 卡片 padding | 14px top/bottom, 14px left/right |
| 左側色條 | width 3px, border-radius 2px, 無 border-radius on card |
| 帳號名稱 | 14px, weight 500, 單行 ellipsis |
| alias · region | 12px, muted，格式：`{alias} · {region}` |
| Resource chip | 11px, bg-secondary, padding 3px 8px, radius-md |
| 費用 | 14px, weight 500 |
| 同步時間 | 11px, tertiary |
| 分隔線（footer）| `border-top: 0.5px solid var(--color-border-tertiary)` |
| 卡片 hover | border-color 升至 `--color-border-secondary` |

---

### Alert Badge

- 只在 `alerts.count > 0` 時顯示
- 背景：`--color-background-danger`，文字：`--color-text-danger`
- 格式：`⚠ N`（icon + 數字）
- font-size 11px, padding 2px 7px, border-radius 10px

---

### Sync Status

| 狀態 | 顯示 |
|-----|------|
| 同步完成 | `↻ N 分鐘前` / `N 小時前` |
| 同步中 | `⏱ 同步中...`（灰色） |
| 同步失敗 | `✗ 同步失敗`（danger 色） |
| 從未同步 | `─ 尚未同步`（muted） |

---

### Add Account Button

- 虛線 border：`0.5px dashed var(--color-border-secondary)`
- hover：`bg-secondary`
- 文字：`+ 新增阿里雲帳號` / `+ 新增騰訊雲帳號`
- 置於對應欄位末端

---

## States & Interactions

| 元素 | 狀態 | 行為 |
|-----|------|------|
| Account card | hover | border-color 升至 secondary |
| Account card | click | 展開側邊抽屜（drawer）顯示詳情 |
| 告警 badge | click | 跳轉告警列表，自動篩選此帳號 |
| Sync icon | click | 觸發手動同步（`POST /api/accounts/:id/sync`） |
| Sync icon | syncing | 旋轉動畫，按鈕 disabled |
| Add button | click | 開啟新增帳號 Modal |
| Add button | hover | `bg-secondary` |

---

## Animation / Motion

| 元素 | 觸發 | 動畫 | Duration | Easing |
|-----|------|------|---------|--------|
| Sync icon | 同步中 | `rotate 360deg` 循環 | 1000ms | linear |
| Alert badge | 首次出現 | `fadeIn + scale 0.8→1` | 200ms | ease-out |
| Account card | 新增帳號後插入 | `slideDown + fadeIn` | 250ms | ease-out |

---

## Edge Cases

| 情境 | 處理方式 |
|-----|---------|
| 無任何帳號 | 雙欄各顯示空狀態插圖 + 新增按鈕，Summary Bar 全 0 |
| 帳號名稱超長 | 單行 `text-overflow: ellipsis`，hover tooltip 顯示全名 |
| 費用 = 0 | 顯示 `¥0 / 月`（不隱藏） |
| 同步失敗 > 3 次 | 帳號卡顯示橘色邊框警示 |
| 告警數 ≥ 10 | 顯示 `9+` |
| 帳號數量多（> 6）| 欄位出現獨立捲軸，`max-height: calc(100vh - 180px)` |

---

## Accessibility

- 告警 badge 需 `aria-label="N 個活躍告警"`
- Sync 按鈕需 `aria-label="手動同步 {帳號名稱}"`，同步中時加 `aria-live="polite"`
- 色條為裝飾性，加 `aria-hidden="true"`
- Tab 順序：Summary → 阿里雲欄 cards → 阿里雲新增按鈕 → 騰訊雲欄 cards → 騰訊雲新增按鈕
- 所有互動元素需 visible focus ring：`box-shadow: 0 0 0 2px var(--color-border-info)`

---

## API Mapping

| UI 元素 | API |
|--------|-----|
| Summary 總帳號數 | `GET /api/accounts?count=true` |
| Summary 本月費用 | `GET /api/resources/overview` → `totalMonthCost` |
| Summary 活躍告警 | `GET /api/alerts?resolved=false&count=true` |
| 帳號列表 | `GET /api/accounts` |
| 手動同步 | `POST /api/accounts/:id/sync` |
| 刪除帳號 | `DELETE /api/accounts/:id` |

---

## Tech Stack Notes（React 實作）

```jsx
// Provider 顏色由 account.provider 決定，不 hardcode
const PROVIDER_THEME = {
  ALIYUN:  { accent: '#EF9F27', badgeBg: '#FAEEDA', badgeText: '#633806' },
  TENCENT: { accent: '#378ADD', badgeBg: '#E6F1FB', badgeText: '#0C447C' },
}

// 帳號卡使用 account.provider 做分欄
const aliyunAccounts  = accounts.filter(a => a.provider === 'ALIYUN')
const tencentAccounts = accounts.filter(a => a.provider === 'TENCENT')
```

資料 polling：每 60 秒 refetch，同步中的帳號每 5 秒 refetch 直到 `syncStatus !== 'syncing'`。
