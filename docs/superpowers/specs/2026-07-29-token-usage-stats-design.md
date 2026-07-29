# Token 消耗统计设计

## 概述

在 User 和 Channel 列表的状态列 tooltip 中展示累计 token 消耗，在 Dashboard 模型数据分析面板增加 Quota/Tokens/Calls 统一指标切换。涉及超管和普通用户的 /console 两个视角。

## 决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| 累计 token 存储方式 | User/Channel 表加 `UsedTokens int64` 字段 | O(1) 查询，与 `UsedQuota`/`RequestCount` 模式一致 |
| 历史数据 | 从 0 开始，不回填 | 简单无风险，用户明确选择 |
| Dashboard 切换方式 | 面板顶部统一切换 | 用户明确选择，所有图表统一按指标渲染 |
| 溢出防护 | `int64`/`bigint` | 9.2×10¹⁸ 上限，远超实际消耗 |

## 后端改动

### 1. 数据模型

#### User 表 (`model/user.go:96`)

在 `UsedQuota` 和 `RequestCount` 后新增：

```go
UsedTokens int64 `json:"used_tokens" gorm:"bigint;default:0;column:used_tokens"` // 累计 token 消耗
```

#### Channel 表 (`model/channel.go:41`)

在 `UsedQuota` 后新增：

```go
UsedTokens int64 `json:"used_tokens" gorm:"bigint;default:0;column:used_tokens"` // 累计 token 消耗
```

两个字段都用 `int64` + `gorm:"bigint"`。GORM `AutoMigrate` 会执行 `ALTER TABLE ... ADD COLUMN used_tokens bigint DEFAULT 0`，兼容 SQLite/MySQL/PostgreSQL。

遵循 AGENTS.md 规则：不使用 `default:true` 类 GORM boolean 标签；数值默认值 `default:0` 在三数据库下行为一致。

### 2. 批量更新系统 (`model/utils.go`)

新增 `BatchUpdateTypeUsedTokens` 和 `BatchUpdateTypeChannelUsedTokens` 两个批量更新类型：

```go
const (
    BatchUpdateTypeUserQuota = iota
    BatchUpdateTypeTokenQuota
    BatchUpdateTypeUsedQuota
    BatchUpdateTypeChannelUsedQuota
    BatchUpdateTypeRequestCount
    BatchUpdateTypeUsedTokens          // 新增：用户 token 累计
    BatchUpdateTypeChannelUsedTokens   // 新增：渠道 token 累计
    BatchUpdateTypeCount
)
```

`batchUpdate()` 中：
- `BatchUpdateTypeUsedTokens` 与 `BatchUpdateTypeUsedQuota`/`BatchUpdateTypeRequestCount` 一起处理（同一用户的三种更新合并到一次 DB 写入），扩展 `updateUserQuotaUsedQuotaAndRequestCount` → `updateUserQuotaUsedQuotaRequestCountAndTokens`
- `BatchUpdateTypeChannelUsedTokens` 与 `BatchUpdateTypeChannelUsedQuota` 合并处理，扩展 `updateChannelUsedQuota` → 同时更新 `used_tokens`

### 3. 结算路径

核心原则：token 累加与 quota 累加在同一调用点同步执行，避免漏算或双算。

#### 3.1 修改签名

`model.UpdateUserUsedQuotaAndRequestCount`:
```go
// 旧: func UpdateUserUsedQuotaAndRequestCount(id int, quota int)
// 新: func UpdateUserUsedQuotaAndRequestCount(id int, quota int, tokens int64)
```

`model.UpdateChannelUsedQuota`:
```go
// 旧: func UpdateChannelUsedQuota(id int, quota int)
// 新: func UpdateChannelUsedQuota(id int, quota int, tokens int64)
```

批量模式下，`UpdateUserUsedQuotaAndRequestCount` 额外调用 `addNewRecord(BatchUpdateTypeUsedTokens, id, int(tokens))`；`UpdateChannelUsedQuota` 额外调用 `addNewRecord(BatchUpdateTypeChannelUsedTokens, id, int(tokens))`。

非批量模式下，在同一个 `gorm.Expr` 更新 map 中加入 `"used_tokens": gorm.Expr("used_tokens + ?", tokens)`。

#### 3.2 调用点修改（8 处）

每处调用点需要传入 token 数量。token 来源因路径不同而异：

| 调用点 | 文件 | token 来源 |
|---|---|---|
| 文本消费结算 | `service/text_quota.go:447` | `summary.TotalTokens`（`int64(summary.PromptTokens + summary.CompletionTokens)`） |
| WSS 音频结算 | `service/quota.go:227` | `usage.TotalTokens`（`usage.InputTokens + usage.OutputTokens`） |
| 音频消费结算 | `service/quota.go:350` | `usage.TotalTokens`（`usage.PromptTokens + usage.CompletionTokens`） |
| 任务消费日志 | `service/task_billing.go:65` | `0`（任务计费无 token 概念） |
| 任务差额结算 | `service/task_billing.go:250` | `0`（同上） |
| MJ SwapFace | `relay/mjproxy_handler.go:255` | `0`（图片生成无 token） |
| MJ Action | `relay/mjproxy_handler.go:561` | `0`（同上） |
| 违规费用 | `service/violation_fee.go:131` | `0`（罚款无 token） |

`summary.TotalTokens` 在 `text_quota.go:259` 已计算为 `usage.PromptTokens + usage.CompletionTokens`，直接用。

**边界处理**：`totalTokens == 0` 的分支（上游超时等）当前不调用 `UpdateUserUsedQuotaAndRequestCount`。保持不变——0 token 不累加，与现有 quota 逻辑一致。

#### 3.3 批量更新合并写入

`batchUpdate()` 中的用户合并写入部分，当前将 `userQuotaStore`/`usedQuotaStore`/`requestCountStore` 三个 store 按 userID 合并到 `updateUserQuotaUsedQuotaAndRequestCount`。新增 `usedTokensStore` 后，合并逻辑扩展为四合一：

```go
func updateUserQuotaUsedQuotaRequestCountAndTokens(
    id int, quota int, usedQuota int, requestCount int, usedTokens int64,
)
```

渠道部分，当前 `BatchUpdateTypeChannelUsedQuota` 在通用循环中单独调用 `updateChannelUsedQuota`。改为：新增 `BatchUpdateTypeChannelUsedTokens` 也在通用循环中处理，扩展 `updateChannelUsedQuota` 同时更新两个字段。或合并到一次调用。

### 4. API 响应

#### 4.1 用户列表 / 用户自身信息

`controller/user.go:533` `buildSelfUserData` 中已有 `used_quota` 和 `request_count`，新增 `"used_tokens": user.UsedTokens`。

管理员用户列表 API 已通过 GORM 返回完整 User struct（含 JSON tag），`used_tokens` 会自动序列化。

`web/src/stores/auth-store.ts` 的 `AuthUser` 接口新增 `used_tokens?: number`。

#### 4.2 渠道列表

Channel struct 已有 JSON tag `json:"used_tokens"`，GORM 查询自动返回。无需改 controller。

### 5. QuotaData（无改动）

`QuotaData.TokenUsed` 已存在，`LogQuotaData` 在 `RecordConsumeLog` 中已写入 `params.PromptTokens + params.CompletionTokens`。Dashboard 数据源完整，本次不改动。

## 前端改动

### 6. 类型定义

#### `web/src/features/users/types.ts`

`userSchema` 新增 `used_tokens: z.number().default(0)`。

#### `web/src/features/channels/types.ts`

`channelSchema` 新增 `used_tokens: z.number().default(0)`。

#### `web/src/stores/auth-store.ts`

`AuthUser` 接口新增 `used_tokens?: number`。

### 7. 用户状态列 tooltip (`web/src/features/users/components/users-columns.tsx:148-152`)

当前 tooltip 内容：
```tsx
<p className='text-xs'>
  {t('Requests:')} {requestCount.toLocaleString()}
</p>
```

改为：
```tsx
<div className='space-y-0.5 text-xs'>
  <div>{t('Requests:')} {requestCount.toLocaleString()}</div>
  <div>{t('Tokens:')} {Number(user.used_tokens ?? 0).toLocaleString()}</div>
</div>
```

`TooltipContent` 从单个 `<p>` 改为 `<div>` 容器包裹多行。使用 `Number(user.used_tokens ?? 0)` 做 null-safe 转换；`toLocaleString()` 做千分位格式化。

### 8. 渠道状态列 tooltip (`web/src/features/channels/components/channels-columns.tsx`)

当前渠道状态列（line 858-975）的 tooltip 仅在 `status === 3`（自动禁用）时显示原因和时间。需要为所有渠道状态增加 token 消耗 tooltip。

**方案**：在普通渠道状态 Badge（line 963-970 的 `return <StatusBadge .../>`）外包一层 Tooltip，显示 Used Tokens。与用户状态列保持一致的结构：`StatusBadge` 作为 trigger，tooltip 显示 token 消耗。

Tag 聚合行（line 869-897）的 tooltip 中也追加 token 信息，需从 `children` 聚合 `used_tokens`。`channel-utils.ts:678` 的 `tagRow.used_quota += channel.used_quota` 处同步增加 `tagRow.used_tokens += channel.used_tokens`。

### 9. 普通用户 /console

普通用户 /console 的 Overview dashboard 中 `SummaryCards`（`web/src/features/dashboard/components/overview/summary-cards.tsx`）显示 `usedQuota` 和 `requestCount`。在 `useSummaryCardsConfig`（`use-dashboard-config.tsx:93-129`）的返回数组中新增一个 token 卡片，或在现有 summaryValues 中加入 `usedTokens`。

同时，普通用户也能访问 Dashboard 的模型分析面板（与超管共用 `Dashboard` 组件），因此模型面板的 Quota/Tokens/Calls 切换对普通用户同样生效。

### 10. Dashboard 模型面板统一指标切换

#### 10.1 新增类型

`web/src/features/dashboard/types.ts` 新增：

```typescript
export type ModelAnalyticsMetric = 'quota' | 'tokens' | 'calls'
```

与 `FlowMetric`（`'quota' | 'tokens' | 'requests'`）平行但语义独立（模型分析用 "calls" 而非 "requests"）。

#### 10.2 状态提升

在 `web/src/features/dashboard/index.tsx` 的 `Dashboard` 组件中新增状态：

```typescript
const [modelMetric, setModelMetric] = useState<ModelAnalyticsMetric>('quota')
```

将 `modelMetric` 传入 `ConsumptionDistributionChart` 和 `ModelCharts` 两个子组件。

#### 10.3 切换器 UI

在模型面板顶部（`index.tsx:348-392` 的 `activeSection === 'models'` 块内），在 `sectionActions` 或紧跟 section tabs 后放置一组切换按钮。参考 Flow 图表的 `METRIC_TABS`（`flow-charts.tsx:104-107`）模式：

```typescript
const MODEL_METRIC_OPTIONS = [
  { value: 'quota', labelKey: 'Quota', icon: WalletCards },
  { value: 'tokens', labelKey: 'Tokens', icon: Hash },
  { value: 'calls', labelKey: 'Calls', icon: Activity },
] as const
```

#### 10.4 `processChartData` 扩展 (`web/src/features/dashboard/lib/charts.ts`)

当前 `processChartData` 硬编码：
- `spec_line` / `spec_area`（额度分布）：yField=`Usage`，值 = quota → USD
- `spec_model_line`（趋势）：yField=`Count`，值 = count
- `spec_pie`（占比）：value = count
- `spec_rank_bar`（排名）：yField=`Count`，值 = count
- `totalQuotaDisplay` = quota 格式化
- `totalCountDisplay` = count 格式化

扩展 `processChartData` 签名增加 `metric?: ModelAnalyticsMetric` 参数（默认 `'quota'`）。根据 metric 选择数据字段和格式化函数：

| spec | quota | tokens | calls |
|---|---|---|---|
| spec_line / spec_area (yField) | `Usage` (quota→USD) | `Tokens` (raw int) | `Count` (raw int) |
| spec_pie (valueField) | quota | tokens | count |
| spec_model_line (yField) | `Usage` (quota→USD) | `Tokens` (raw int) | `Count` (raw int) |
| spec_rank_bar (yField) | `Usage` (quota→USD) | `Tokens` (raw int) | `Count` (raw int) |
| totalDisplay | `totalQuotaDisplay` | `totalTokensDisplay` | `totalCountDisplay` |

数据已在 `timeModelMap` 和 `modelTotalsMap` 中聚合了 `{ quota, count, tokens }` 三个维度（`charts.ts:221-258`），无需重新聚合。

`ProcessedChartData` 类型新增 `totalTokensDisplay: string`。

格式化函数：
- quota: 现有 `renderQuotaCompat`
- tokens: `formatInt`（`Intl.NumberFormat`，0 小数位）
- calls: `formatInt`

#### 10.5 `ConsumptionDistributionChart` 改动

接收 `metric` prop，传给 `processChartData`。标题从硬编码 `t('Quota Distribution')` 改为根据 metric 切换：`t('Quota Distribution')` / `t('Token Distribution')` / `t('Call Distribution')`。`chartData.totalQuotaDisplay` 改为根据 metric 选择对应的 totalDisplay。

#### 10.6 `ModelCharts` 改动

接收 `metric` prop，传给 `processChartData`。`chartData.totalCountDisplay`（line 132）改为根据 metric 选择。三个 tab（trend/proportion/top）的 spec 已经在 `processChartData` 中根据 metric 生成，组件本身不需按 metric 切换逻辑。

### 11. i18n

新增的 i18n key（英文为 key 本身）：
- `Tokens:`
- `Token Distribution`
- `Call Distribution`
- `Tokens`（已存在于 Flow 图表）
- `Calls`
- `Total Tokens`（已存在于 stat cards）

需同步到 `web/src/i18n/locales/` 下的 zh, zh-TW, fr, ru, ja, vi。使用 `bun run i18n:sync`（在 `web/` 目录下）。

## 溢出防护

| 层 | 类型 | 上限 | 风险评估 |
|---|---|---|---|
| DB `User.UsedTokens` | `bigint` | 9.2×10¹⁸ | 安全 |
| DB `Channel.UsedTokens` | `bigint` | 9.2×10¹⁸ | 安全 |
| Go `int64` | `int64` | 9.2×10¹⁸ | 安全 |
| 批量更新 `map[int]int` | Go `int` (64-bit) | 2⁶³-1 | 安全 |
| `summary.TotalTokens` | `int` → cast `int64` | 2³¹-1 → 2⁶³-1 | 单次请求 token 不超 2³¹，安全 |
| 前端 JS `number` | `double` | 2⁵³ ≈ 9×10¹⁵ | 累计到达 9×10¹⁵ token 需约 10⁹ 次请求，实际不可能 |
| 前端 `toLocaleString()` | `string` | 无上限 | 格式化无溢出 |

现有 `QuotaData.TokenUsed` 为 `int`（MySQL `INT` 32-bit），但这是每小时聚合值，单小时 2.1×10⁹ token 不现实，不改动。

## 不改动项

- `QuotaData` 表及其聚合逻辑：已完整支持 token 数据
- `LogQuotaData` / `RecordConsumeLog`：token 已写入 QuotaData
- Flow 图表：已有 Quota/Tokens/Requests 切换，不在本次范围
- 用户分析图表（`processUserChartData`）：当前仅按 quota，可在后续迭代扩展

## 验证方案

1. **后端编译**：`go build ./...`
2. **数据库 migration**：启动后检查 `ALTER TABLE users ADD COLUMN used_tokens` 和 `ALTER TABLE channels ADD COLUMN used_tokens` 在 SQLite 下执行
3. **结算路径**：发一条文本请求，验证 `users.used_tokens` 和 `channels.used_tokens` 正确累加 `prompt_tokens + completion_tokens`
4. **批量模式**：设置 `BatchUpdateEnabled=true`，发请求后等待批量刷新，验证累加正确
5. **前端 tooltip**：用户列表和渠道列表状态列 hover 显示 token 消耗
6. **Dashboard 切换**：模型面板顶部切换 Quota/Tokens/Calls，两个图表同步切换指标
7. **普通用户视角**：普通用户 /console 的 overview 和 dashboard 功能正常
8. **溢出**：构造超大 token 值的请求验证不溢出（int64 范围内）
