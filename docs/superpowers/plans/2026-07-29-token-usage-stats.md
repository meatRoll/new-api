# Token 消耗统计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cumulative token consumption tracking to User and Channel tables, display it in status column tooltips, and add a unified Quota/Tokens/Calls metric switcher to the Dashboard model analytics panel.

**Architecture:** Add `UsedTokens int64` to User and Channel models. Extend the settlement path (8 call sites) to pass token counts alongside quota. Extend the batch update system with 2 new types. On the frontend, add token display to user/channel status tooltips, a panel-level metric switcher for dashboard model charts, and a token summary card for the user overview.

**Tech Stack:** Go 1.22, GORM v2, React 19, TypeScript, VChart, i18next, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-07-29-token-usage-stats-design.md`

---

## File Structure

### Backend (modified)
| File | Responsibility |
|---|---|
| `model/user.go` | Add `UsedTokens` field; modify `UpdateUserUsedQuotaAndRequestCount` + helpers |
| `model/channel.go` | Add `UsedTokens` field; modify `UpdateChannelUsedQuota` + helper |
| `model/utils.go` | Add 2 batch update types; extend `batchUpdate()` merge logic |
| `service/text_quota.go` | Pass `summary.TotalTokens` to settlement call |
| `service/quota.go` | Pass `usage.TotalTokens` to 2 settlement calls |
| `service/task_billing.go` | Pass `0` to 2 settlement calls |
| `service/violation_fee.go` | Pass `0` to settlement call |
| `relay/mjproxy_handler.go` | Pass `0` to 2 settlement calls |
| `controller/user.go` | Add `used_tokens` to `buildSelfUserData` |

### Backend (created)
| File | Responsibility |
|---|---|
| `model/user_token_stats_test.go` | Test token accumulation invariants for User and Channel |

### Frontend (modified)
| File | Responsibility |
|---|---|
| `web/src/stores/auth-store.ts` | Add `used_tokens` to `AuthUser` interface |
| `web/src/features/users/types.ts` | Add `used_tokens` to `userSchema` |
| `web/src/features/channels/types.ts` | Add `used_tokens` to `channelSchema` |
| `web/src/features/users/components/users-columns.tsx` | Add token to status tooltip |
| `web/src/features/channels/components/channels-columns.tsx` | Add token to status tooltip |
| `web/src/features/channels/lib/channel-utils.ts` | Add `used_tokens` aggregation for tag rows |
| `web/src/features/dashboard/types.ts` | Add `ModelAnalyticsMetric` type + `totalTokensDisplay` |
| `web/src/features/dashboard/index.tsx` | Add metric state + toggle UI |
| `web/src/features/dashboard/lib/charts.ts` | Extend `processChartData` with metric param |
| `web/src/features/dashboard/components/models/consumption-distribution-chart.tsx` | Accept metric prop |
| `web/src/features/dashboard/components/models/model-charts.tsx` | Accept metric prop |
| `web/src/features/dashboard/hooks/use-dashboard-config.tsx` | Add token card to summary config |
| `web/src/features/dashboard/components/overview/summary-cards.tsx` | Pass token data to summary config |

---

## Task 1: Add UsedTokens field to User and Channel models

**Files:**
- Modify: `model/user.go:97` (after `RequestCount` field)
- Modify: `model/channel.go:41` (after `UsedQuota` field)

- [ ] **Step 1: Add UsedTokens to User struct**

In `model/user.go`, after line 97 (`RequestCount` field), add:

```go
	UsedTokens      int64                      `json:"used_tokens" gorm:"bigint;default:0;column:used_tokens"` // 累计 token 消耗
```

- [ ] **Step 2: Add UsedTokens to Channel struct**

In `model/channel.go`, after line 41 (`UsedQuota` field), add:

```go
	UsedTokens        int64   `json:"used_tokens" gorm:"bigint;default:0;column:used_tokens"` // 累计 token 消耗
```

- [ ] **Step 3: Verify backend compiles**

Run: `go build ./...`
Expected: PASS (GORM AutoMigrate will handle the new column at runtime)

- [ ] **Step 4: Commit**

```bash
git add model/user.go model/channel.go
git commit -m "feat: add UsedTokens int64 field to User and Channel models"
```

---

## Task 2: Backend settlement path — models, batch update, and all call sites

This is one atomic change: function signatures change in `model/`, the batch merge logic in `model/utils.go` references the new signatures, and all 8 call sites in `service/` + `relay/` must be updated together. The build only passes after all steps are done.

**Files:**
- Modify: `model/utils.go:14-21,78-112` (batch types + merge logic)
- Modify: `model/user.go:1309-1351` (UpdateUserUsedQuotaAndRequestCount + helpers)
- Modify: `model/channel.go:861-874` (UpdateChannelUsedQuota + helper)
- Modify: `service/text_quota.go:447`
- Modify: `service/quota.go:227,350`
- Modify: `service/task_billing.go:65,250`
- Modify: `service/violation_fee.go:131`
- Modify: `relay/mjproxy_handler.go:255,561`
- Create: `model/user_token_stats_test.go`

- [ ] **Step 1: Write the failing test**

Create `model/user_token_stats_test.go`:

```go
package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTokenStatsTestState(t *testing.T) {
	t.Helper()
	truncateTables(t)
	require.NoError(t, DB.Exec("DELETE FROM users").Error)
	require.NoError(t, DB.Exec("DELETE FROM channels").Error)

	oldRedisEnabled := common.RedisEnabled
	oldBatchUpdateEnabled := common.BatchUpdateEnabled
	common.RedisEnabled = false
	common.BatchUpdateEnabled = false
	t.Cleanup(func() {
		common.RedisEnabled = oldRedisEnabled
		common.BatchUpdateEnabled = oldBatchUpdateEnabled
	})
}

func TestUpdateUserUsedQuotaAndRequestCountAccumulatesTokens(t *testing.T) {
	setupTokenStatsTestState(t)

	user := User{
		Id:         1,
		Username:   "token-stats-user",
		Password:   "password",
		Status:     common.UserStatusEnabled,
		Quota:      10000,
		UsedQuota:  100,
		UsedTokens: 500,
	}
	require.NoError(t, DB.Create(&user).Error)

	UpdateUserUsedQuotaAndRequestCount(user.Id, 200, 1500)

	var got User
	require.NoError(t, DB.First(&got, user.Id).Error)
	assert.Equal(t, 300, got.UsedQuota, "used_quota should accumulate")
	assert.Equal(t, int64(2000), got.UsedTokens, "used_tokens should accumulate")
	assert.Equal(t, 1, got.RequestCount, "request_count should increment by 1")
}

func TestUpdateChannelUsedQuotaAccumulatesTokens(t *testing.T) {
	setupTokenStatsTestState(t)

	ch := Channel{
		Id:         1,
		Name:       "token-stats-channel",
		Type:       1,
		Status:     1,
		UsedQuota:  100,
		UsedTokens: 500,
	}
	require.NoError(t, DB.Create(&ch).Error)

	UpdateChannelUsedQuota(ch.Id, 200, 1500)

	var got Channel
	require.NoError(t, DB.First(&got, ch.Id).Error)
	assert.Equal(t, int64(300), got.UsedQuota, "used_quota should accumulate")
	assert.Equal(t, int64(2000), got.UsedTokens, "used_tokens should accumulate")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./model/ -run "TestUpdateUserUsedQuotaAndRequestCountAccumulatesTokens|TestUpdateChannelUsedQuotaAccumulatesTokens" -v`
Expected: FAIL — `UpdateUserUsedQuotaAndRequestCount` and `UpdateChannelUsedQuota` still take 2 args.

- [ ] **Step 3: Add new batch update type constants**

In `model/utils.go`, replace the const block (lines 14-21):

```go
const (
	BatchUpdateTypeUserQuota = iota
	BatchUpdateTypeTokenQuota
	BatchUpdateTypeUsedQuota
	BatchUpdateTypeChannelUsedQuota
	BatchUpdateTypeRequestCount
	BatchUpdateTypeUsedTokens         // user token consumption
	BatchUpdateTypeChannelUsedTokens  // channel token consumption
	BatchUpdateTypeCount              // if you add a new type, you need to add a new map and a new lock
)
```

- [ ] **Step 4: Rewrite batchUpdate() merge logic**

In `model/utils.go`, replace the entire `batchUpdate()` function body (lines 52-113). The new version skips user and channel stores in the general loop, then merges them separately:

```go
func batchUpdate() {
	// check if there's any data to update
	hasData := false
	for i := 0; i < BatchUpdateTypeCount; i++ {
		batchUpdateLocks[i].Lock()
		if len(batchUpdateStores[i]) > 0 {
			hasData = true
			batchUpdateLocks[i].Unlock()
			break
		}
		batchUpdateLocks[i].Unlock()
	}

	if !hasData {
		return
	}

	common.SysLog("batch update started")
	stores := make([]map[int]int, BatchUpdateTypeCount)
	for i := 0; i < BatchUpdateTypeCount; i++ {
		batchUpdateLocks[i].Lock()
		stores[i] = batchUpdateStores[i]
		batchUpdateStores[i] = make(map[int]int)
		batchUpdateLocks[i].Unlock()
	}

	// Process token quota in the general loop (only non-merged type)
	tokenQuotaStore := stores[BatchUpdateTypeTokenQuota]
	for key, value := range tokenQuotaStore {
		err := increaseTokenQuota(key, value)
		if err != nil {
			common.SysLog("failed to batch update token quota: " + err.Error())
		}
	}

	// Merge user stores: quota + usedQuota + requestCount + usedTokens → one update per user
	userQuotaStore := stores[BatchUpdateTypeUserQuota]
	usedQuotaStore := stores[BatchUpdateTypeUsedQuota]
	requestCountStore := stores[BatchUpdateTypeRequestCount]
	usedTokensStore := stores[BatchUpdateTypeUsedTokens]

	userIDs := make(map[int]struct{}, len(userQuotaStore)+len(usedQuotaStore)+len(requestCountStore)+len(usedTokensStore))
	for key := range userQuotaStore {
		userIDs[key] = struct{}{}
	}
	for key := range usedQuotaStore {
		userIDs[key] = struct{}{}
	}
	for key := range requestCountStore {
		userIDs[key] = struct{}{}
	}
	for key := range usedTokensStore {
		userIDs[key] = struct{}{}
	}
	for key := range userIDs {
		updateUserQuotaUsedQuotaRequestCountAndTokens(key, userQuotaStore[key], usedQuotaStore[key], requestCountStore[key], int64(usedTokensStore[key]))
	}

	// Merge channel stores: usedQuota + usedTokens → one update per channel
	channelQuotaStore := stores[BatchUpdateTypeChannelUsedQuota]
	channelTokenStore := stores[BatchUpdateTypeChannelUsedTokens]
	channelIDs := make(map[int]struct{}, len(channelQuotaStore)+len(channelTokenStore))
	for key := range channelQuotaStore {
		channelIDs[key] = struct{}{}
	}
	for key := range channelTokenStore {
		channelIDs[key] = struct{}{}
	}
	for key := range channelIDs {
		updateChannelUsedQuota(key, channelQuotaStore[key], int64(channelTokenStore[key]))
	}

	common.SysLog("batch update finished")
}
```

Note: `updateChannelUsedQuota` is now called directly (lowercase, unexported) from the batch path, not `UpdateChannelUsedQuota` (exported), to avoid re-entering the batch path. This matches the existing pattern where the batch path calls `increaseTokenQuota` directly.

- [ ] **Step 5: Modify User settlement functions**

In `model/user.go`, replace `UpdateUserUsedQuotaAndRequestCount` (lines 1309-1316):

```go
func UpdateUserUsedQuotaAndRequestCount(id int, quota int, tokens int64) {
	if common.BatchUpdateEnabled {
		addNewRecord(BatchUpdateTypeUsedQuota, id, quota)
		addNewRecord(BatchUpdateTypeRequestCount, id, 1)
		addNewRecord(BatchUpdateTypeUsedTokens, id, int(tokens))
		return
	}
	updateUserUsedQuotaAndRequestCount(id, quota, 1, tokens)
}
```

Replace `updateUserUsedQuotaAndRequestCount` (lines 1318-1334):

```go
func updateUserUsedQuotaAndRequestCount(id int, quota int, count int, tokens int64) {
	err := DB.Model(&User{}).Where("id = ?", id).Updates(
		map[string]interface{}{
			"used_quota":    gorm.Expr("used_quota + ?", quota),
			"request_count": gorm.Expr("request_count + ?", count),
			"used_tokens":   gorm.Expr("used_tokens + ?", tokens),
		},
	).Error
	if err != nil {
		common.SysLog("failed to update user used quota, request count and tokens: " + err.Error())
		return
	}
}
```

Replace `updateUserQuotaUsedQuotaAndRequestCount` (lines 1336-1351) with the 4-in-1 version:

```go
func updateUserQuotaUsedQuotaRequestCountAndTokens(id int, quota int, usedQuota int, requestCount int, usedTokens int64) {
	if quota == 0 && usedQuota == 0 && requestCount == 0 && usedTokens == 0 {
		return
	}

	err := DB.Model(&User{}).Where("id = ?", id).Updates(
		map[string]interface{}{
			"quota":         gorm.Expr("quota + ?", quota),
			"used_quota":    gorm.Expr("used_quota + ?", usedQuota),
			"request_count": gorm.Expr("request_count + ?", requestCount),
			"used_tokens":   gorm.Expr("used_tokens + ?", usedTokens),
		},
	).Error
	if err != nil {
		common.SysLog("failed to batch update user quota, used quota, request count and tokens: " + err.Error())
	}
}
```

- [ ] **Step 6: Modify Channel settlement functions**

In `model/channel.go`, replace `UpdateChannelUsedQuota` (lines 861-867):

```go
func UpdateChannelUsedQuota(id int, quota int, tokens int64) {
	if common.BatchUpdateEnabled {
		addNewRecord(BatchUpdateTypeChannelUsedQuota, id, quota)
		addNewRecord(BatchUpdateTypeChannelUsedTokens, id, int(tokens))
		return
	}
	updateChannelUsedQuota(id, quota, tokens)
}
```

Replace `updateChannelUsedQuota` (lines 869-874):

```go
func updateChannelUsedQuota(id int, quota int, tokens int64) {
	err := DB.Model(&Channel{}).Where("id = ?", id).Updates(
		map[string]interface{}{
			"used_quota":  gorm.Expr("used_quota + ?", quota),
			"used_tokens": gorm.Expr("used_tokens + ?", tokens),
		},
	).Error
	if err != nil {
		common.SysLog(fmt.Sprintf("failed to update channel used quota and tokens: channel_id=%d, delta_quota=%d, delta_tokens=%d, error=%v", id, quota, tokens, err))
	}
}
```

- [ ] **Step 7: Update text quota call site**

In `service/text_quota.go:447`, replace:

```go
		model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, summary.Quota)
		model.UpdateChannelUsedQuota(relayInfo.ChannelId, summary.Quota)
```

with:

```go
		model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, summary.Quota, int64(summary.TotalTokens))
		model.UpdateChannelUsedQuota(relayInfo.ChannelId, summary.Quota, int64(summary.TotalTokens))
```

- [ ] **Step 8: Update WSS consume call site**

In `service/quota.go:227`, replace:

```go
		model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, quota)
		model.UpdateChannelUsedQuota(relayInfo.ChannelId, quota)
```

with:

```go
		model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, quota, int64(usage.TotalTokens))
		model.UpdateChannelUsedQuota(relayInfo.ChannelId, quota, int64(usage.TotalTokens))
```

- [ ] **Step 9: Update audio consume call site**

In `service/quota.go:350`, replace:

```go
		model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, quota)
		model.UpdateChannelUsedQuota(relayInfo.ChannelId, quota)
```

with:

```go
		model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, quota, int64(usage.TotalTokens))
		model.UpdateChannelUsedQuota(relayInfo.ChannelId, quota, int64(usage.TotalTokens))
```

- [ ] **Step 10: Update task billing call site 1 (LogTaskConsumption)**

In `service/task_billing.go:65`, replace:

```go
	model.UpdateUserUsedQuotaAndRequestCount(info.UserId, info.PriceData.Quota)
	model.UpdateChannelUsedQuota(info.ChannelId, info.PriceData.Quota)
```

with:

```go
	model.UpdateUserUsedQuotaAndRequestCount(info.UserId, info.PriceData.Quota, 0)
	model.UpdateChannelUsedQuota(info.ChannelId, info.PriceData.Quota, 0)
```

- [ ] **Step 11: Update task billing call site 2 (差额结算)**

In `service/task_billing.go:250`, replace:

```go
		model.UpdateUserUsedQuotaAndRequestCount(task.UserId, quotaDelta)
		model.UpdateChannelUsedQuota(task.ChannelId, quotaDelta)
```

with:

```go
		model.UpdateUserUsedQuotaAndRequestCount(task.UserId, quotaDelta, 0)
		model.UpdateChannelUsedQuota(task.ChannelId, quotaDelta, 0)
```

- [ ] **Step 12: Update violation fee call site**

In `service/violation_fee.go:131`, replace:

```go
	model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, feeQuota)
	model.UpdateChannelUsedQuota(relayInfo.ChannelId, feeQuota)
```

with:

```go
	model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, feeQuota, 0)
	model.UpdateChannelUsedQuota(relayInfo.ChannelId, feeQuota, 0)
```

- [ ] **Step 13: Update MJ SwapFace call site**

In `relay/mjproxy_handler.go:255`, replace:

```go
			model.UpdateUserUsedQuotaAndRequestCount(info.UserId, priceData.Quota)
			model.UpdateChannelUsedQuota(info.ChannelId, priceData.Quota)
```

with:

```go
			model.UpdateUserUsedQuotaAndRequestCount(info.UserId, priceData.Quota, 0)
			model.UpdateChannelUsedQuota(info.ChannelId, priceData.Quota, 0)
```

- [ ] **Step 14: Update MJ Action call site**

In `relay/mjproxy_handler.go:561`, replace:

```go
			model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, priceData.Quota)
			model.UpdateChannelUsedQuota(relayInfo.ChannelId, priceData.Quota)
```

with:

```go
			model.UpdateUserUsedQuotaAndRequestCount(relayInfo.UserId, priceData.Quota, 0)
			model.UpdateChannelUsedQuota(relayInfo.ChannelId, priceData.Quota, 0)
```

- [ ] **Step 15: Verify backend compiles**

Run: `go build ./...`
Expected: PASS

- [ ] **Step 16: Run the token stats tests**

Run: `go test ./model/ -run "TestUpdateUserUsedQuotaAndRequestCountAccumulatesTokens|TestUpdateChannelUsedQuotaAccumulatesTokens" -v`
Expected: PASS

- [ ] **Step 17: Run all model tests**

Run: `go test ./model/ -v -count=1`
Expected: PASS

- [ ] **Step 18: Commit**

```bash
git add model/utils.go model/user.go model/channel.go model/user_token_stats_test.go service/text_quota.go service/quota.go service/task_billing.go service/violation_fee.go relay/mjproxy_handler.go
git commit -m "feat: extend settlement path to accumulate UsedTokens for User and Channel"
```
---

## Task 3: Add used_tokens to API response

**Files:**
- Modify: `controller/user.go:534` (buildSelfUserData)

- [ ] **Step 1: Add used_tokens to buildSelfUserData**

In `controller/user.go`, after line 534 (`"request_count": user.RequestCount,`), add:

```go
		"used_tokens":       user.UsedTokens,
```

- [ ] **Step 2: Verify backend compiles**

Run: `go build ./...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add controller/user.go
git commit -m "feat: expose used_tokens in user self API response"
```

---

## Task 4: Frontend type definitions

**Files:**
- Modify: `web/src/stores/auth-store.ts:39`
- Modify: `web/src/features/users/types.ts:47`
- Modify: `web/src/features/channels/types.ts:55`

- [ ] **Step 1: Add used_tokens to AuthUser interface**

In `web/src/stores/auth-store.ts`, after line 39 (`request_count?: number`), add:

```typescript
  used_tokens?: number
```

- [ ] **Step 2: Add used_tokens to userSchema**

In `web/src/features/users/types.ts`, after line 47 (`request_count: z.number(),`), add:

```typescript
  used_tokens: z.number().default(0),
```

- [ ] **Step 3: Add used_tokens to channelSchema**

In `web/src/features/channels/types.ts`, after line 55 (`used_quota: z.number().default(0),`), add:

```typescript
  used_tokens: z.number().default(0),
```

- [ ] **Step 4: Verify frontend type-checks**

Run: `cd web && bun run build`
Expected: PASS (type errors only if we miss a call site — the new field has `default(0)` so it's optional in API responses)

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/auth-store.ts web/src/features/users/types.ts web/src/features/channels/types.ts
git commit -m "feat: add used_tokens to frontend type definitions"
```

---

## Task 5: Add token display to user status tooltip

**Files:**
- Modify: `web/src/features/users/components/users-columns.tsx:128-153`

- [ ] **Step 1: Add used_tokens to status cell**

In `web/src/features/users/components/users-columns.tsx`, the status column cell (lines 127-154). After line 129 (`const requestCount = user.request_count`), add:

```tsx
        const usedTokens = Number(user.used_tokens ?? 0)
```

Replace the `TooltipContent` (lines 148-152):

```tsx
            <TooltipContent>
              <p className='text-xs'>
                {t('Requests:')} {requestCount.toLocaleString()}
              </p>
            </TooltipContent>
```

with:

```tsx
            <TooltipContent>
              <div className='space-y-0.5 text-xs'>
                <div>
                  {t('Requests:')} {requestCount.toLocaleString()}
                </div>
                <div>
                  {t('Tokens:')} {usedTokens.toLocaleString()}
                </div>
              </div>
            </TooltipContent>
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd web && bun run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/features/users/components/users-columns.tsx
git commit -m "feat: add token consumption to user status tooltip"
```

---

## Task 6: Add token display to channel status tooltip

**Files:**
- Modify: `web/src/features/channels/components/channels-columns.tsx:863-970`
- Modify: `web/src/features/channels/lib/channel-utils.ts:653,678`

- [ ] **Step 1: Add used_tokens to tag row initialization**

In `web/src/features/channels/lib/channel-utils.ts:653`, after `used_quota: 0,` add:

```typescript
        used_tokens: 0,
```

- [ ] **Step 2: Add used_tokens aggregation to tag row**

In `web/src/features/channels/lib/channel-utils.ts:678`, after `tagRow.used_quota += channel.used_quota` add:

```typescript
    tagRow.used_tokens += channel.used_tokens
```

- [ ] **Step 3: Wrap regular channel status in token tooltip**

In `web/src/features/channels/components/channels-columns.tsx`, the regular channel status return (lines 963-970). Replace:

```tsx
          return (
            <StatusBadge
              label={label}
              variant={config.variant}
              size='sm'
              copyable={false}
            />
          )
```

with:

```tsx
          const usedTokens = Number(channel.used_tokens ?? 0)
          return (
            <Tooltip>
              <TooltipTrigger render={<div className='-ml-1.5 cursor-help' />}>
                <StatusBadge
                  label={label}
                  variant={config.variant}
                  size='sm'
                  copyable={false}
                />
              </TooltipTrigger>
              <TooltipContent>
                <div className='space-y-0.5 text-xs'>
                  <div>
                    {t('Tokens:')} {usedTokens.toLocaleString()}
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          )
```

- [ ] **Step 4: Add token info to auto-disabled tooltip**

In the `status === 3` tooltip (lines 943-956), the `TooltipContent` currently shows reason and time. Add token info after the time div (before closing `</div>` on line 955):

```tsx
                        <div>
                          {t('Tokens:')} {Number(channel.used_tokens ?? 0).toLocaleString()}
                        </div>
```

- [ ] **Step 5: Add token info to tag aggregate row tooltips**

In the tag row section (lines 869-893), wrap both `StatusBadge` returns in tooltips. For the `hasEnabled` branch (lines 874-882), replace:

```tsx
              return (
                <StatusBadge
                  label={`Active (${childrenCount})`}
                  variant='success'
                  size='sm'
                  copyable={false}
                  className='-ml-1.5'
                />
              )
```

with:

```tsx
              const tagUsedTokens = (row.original as TagRow).children?.reduce(
                (sum, ch) => sum + Number(ch.used_tokens ?? 0), 0
              ) ?? 0
              return (
                <Tooltip>
                  <TooltipTrigger render={<div className='-ml-1.5 cursor-help' />}>
                    <StatusBadge
                      label={`Active (${childrenCount})`}
                      variant='success'
                      size='sm'
                      copyable={false}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className='text-xs'>
                      {t('Tokens:')} {tagUsedTokens.toLocaleString()}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )
```

Apply the same pattern to the `else` branch (Inactive), using `variant='neutral'`.

- [ ] **Step 6: Verify frontend builds**

Run: `cd web && bun run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/features/channels/components/channels-columns.tsx web/src/features/channels/lib/channel-utils.ts
git commit -m "feat: add token consumption to channel status tooltip"
```

---

## Task 7: Dashboard metric type and state

**Files:**
- Modify: `web/src/features/dashboard/types.ts:247` (add type + field)
- Modify: `web/src/features/dashboard/index.tsx:201` (add state + toggle UI)

- [ ] **Step 1: Add ModelAnalyticsMetric type**

In `web/src/features/dashboard/types.ts`, after line 247 (`totalCountDisplay: string`), add:

```typescript
  totalTokensDisplay: string
```

After the `ProcessedChartData` interface (after line 248), add:

```typescript

export type ModelAnalyticsMetric = 'quota' | 'tokens' | 'calls'
```

- [ ] **Step 2: Add metric state to Dashboard component**

In `web/src/features/dashboard/index.tsx`, after line 208 (the `modelFilters` state), add:

```typescript
  const [modelMetric, setModelMetric] = useState<ModelAnalyticsMetric>('quota')
```

Add `ModelAnalyticsMetric` to the import from `./types` (line 33-34 area, where `ModelAnalyticsChartTab` is imported).

Add `useState` to the React import if not already present.

- [ ] **Step 3: Add metric toggle UI to modelActions**

In `index.tsx`, the `modelActions` block (lines 267-280). After the `ModelsFilter` component, add the metric toggle before the closing `</>`:

```tsx
        <div className='bg-muted/60 inline-flex h-8 rounded-lg border p-0.5'>
          {([
            { value: 'quota', label: t('Quota') },
            { value: 'tokens', label: t('Tokens') },
            { value: 'calls', label: t('Calls') },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              type='button'
              onClick={() => setModelMetric(opt.value)}
              className={`shrink-0 rounded-md px-3 text-xs font-medium transition-colors ${
                modelMetric === opt.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
```

- [ ] **Step 4: Pass modelMetric to chart components**

In the `activeSection === 'models'` block (lines 366-390), add `metric={modelMetric}` to both `LazyConsumptionDistributionChart` and `LazyModelCharts`:

For `LazyConsumptionDistributionChart` (around line 367), add prop:

```tsx
                  <LazyConsumptionDistributionChart
                    data={modelData}
                    loading={dataLoading}
                    defaultChartType={
                      chartPreferences.consumptionDistributionChart
                    }
                    timeGranularity={
                      modelFilters.time_granularity || DEFAULT_TIME_GRANULARITY
                    }
                    metric={modelMetric}
                  />
```

For `LazyModelCharts` (around line 381), add prop:

```tsx
                  <LazyModelCharts
                    data={modelData}
                    loading={dataLoading}
                    defaultChartTab={chartPreferences.modelAnalyticsChart}
                    timeGranularity={
                      modelFilters.time_granularity || DEFAULT_TIME_GRANULARITY
                    }
                    metric={modelMetric}
                  />
```

- [ ] **Step 5: Verify frontend builds (will fail — chart components don't accept metric yet)**

Run: `cd web && bun run build`
Expected: FAIL — `metric` prop not yet accepted by chart components. Expected; Tasks 11-12 add it.

- [ ] **Step 6: Commit**

```bash
git add web/src/features/dashboard/types.ts web/src/features/dashboard/index.tsx
git commit -m "feat: add ModelAnalyticsMetric type and panel-level metric toggle"
```

---

## Task 8: Extend processChartData with metric support

**Files:**
- Modify: `web/src/features/dashboard/lib/charts.ts:70-75` (signature)
- Modify: `web/src/features/dashboard/lib/charts.ts:145-213` (empty data return)
- Modify: `web/src/features/dashboard/lib/charts.ts:215-305` (data aggregation + spec building)
- Modify: `web/src/features/dashboard/lib/charts.ts:453-688` (spec return)

- [ ] **Step 1: Add metric parameter to processChartData**

In `web/src/features/dashboard/lib/charts.ts`, add the import at the top (after line 26):

```typescript
import type { ModelAnalyticsMetric } from '@/features/dashboard/types'
```

Change the `processChartData` signature (line 70-75) to add `metric`:

```typescript
export function processChartData(
  data: QuotaDataItem[],
  timeGranularity: TimeGranularity = 'day',
  t?: TFunction,
  chartCornerRadius?: number,
  metric: ModelAnalyticsMetric = 'quota'
): ProcessedChartData {
```

- [ ] **Step 2: Add metric-aware helpers inside processChartData**

After the `formatQuotaTotal` definition (line 82), add:

```typescript
  const formatTokens = (value: number) =>
    Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)

  // Select the raw metric value from a stats object
  const getMetricValue = (stats: { quota: number; count: number; tokens: number }): number => {
    if (metric === 'tokens') return stats.tokens
    if (metric === 'calls') return stats.count
    return stats.quota
  }

  // Format a metric value for display
  const formatMetric = (value: number): string => {
    if (metric === 'quota') return formatQuotaValue(value)
    return formatTokens(value)
  }

  // Format a total metric value for display
  const formatMetricTotal = (value: number): string => {
    if (metric === 'quota') return formatQuotaTotal(value)
    return formatTokens(value)
  }

  // Y-field name and value extractor for bar/area/line specs
  const metricYField = metric === 'quota' ? 'Usage' : metric === 'tokens' ? 'Tokens' : 'Count'
```

- [ ] **Step 3: Update empty-data return to include totalTokensDisplay**

In the empty data return (line 210-212), add `totalTokensDisplay`:

```typescript
      totalQuotaDisplay: formatQuotaTotal(0),
      totalTokensDisplay: formatTokens(0),
      totalCountDisplay: formatInt(0),
```

- [ ] **Step 4: Update spec_line / spec_area values to use metric**

The `lineValues` array (lines 316-344) currently builds `{ Time, Model, rawQuota, Usage, TimeSum }`. Replace the `lineValues` construction to use metric-aware fields. Replace lines 316-345:

```typescript
  // Stacked bar / area: model distribution by selected metric
  const lineValues: Array<{
    Time: string
    Model: string
    rawQuota: number
    Usage: number
    TimeSum: number
  }> = []

  chartTimes.forEach((time) => {
    let timeData = sortedModels.map((model) => {
      const stats = timeModelMap.get(time)?.get(model)
      const rawQuota = Number(stats?.quota) || 0
      const metricRaw = getMetricValue(stats || { quota: 0, count: 0, tokens: 0 })
      const usd = rawQuota ? rawQuota / quotaPerUnit : 0
      const usage = metric === 'quota' ? (usd ? Number(usd.toFixed(4)) : 0) : metricRaw
      return {
        Time: time,
        Model: model,
        rawQuota,
        Usage: usage,
        TimeSum: 0,
      }
    })

    const timeSum = timeData.reduce((sum, item) => sum + item.rawQuota, 0)
    timeData.sort((a, b) => b.rawQuota - a.rawQuota)
    timeData = timeData.map((item) => ({ ...item, TimeSum: timeSum }))
    lineValues.push(...timeData)
  })
  lineValues.sort((a, b) => a.Time.localeCompare(b.Time))
```

- [ ] **Step 5: Update areaValues to use metric**

Similarly, the `areaValues` construction (lines 359-387) builds values from `rawQuota`. Replace the metric extraction. In the `sortedModels.forEach` inside the area chart loop, after getting `stats`, add metric-aware value:

Replace lines 364-376:

```typescript
    sortedModels.forEach((model) => {
      const stats = modelMap?.get(model)
      const rawQuota = Number(stats?.quota) || 0
      const metricRaw = getMetricValue(stats || { quota: 0, count: 0, tokens: 0 })
      const usd = rawQuota ? rawQuota / quotaPerUnit : 0
      const usage = metric === 'quota' ? (usd ? Number(usd.toFixed(4)) : 0) : metricRaw
      timeSum += rawQuota
      const key = topAreaModels.has(model) ? model : otherLabel
      const prev = buckets.get(key) || { rawQuota: 0, usage: 0 }
      buckets.set(key, {
        rawQuota: prev.rawQuota + rawQuota,
        usage: metric === 'quota' ? Number((prev.usage + usage).toFixed(4)) : prev.usage + usage,
      })
    })
```

- [ ] **Step 6: Update pie chart to use metric**

The `pieValues` (lines 308-313) currently use `stats.count`. Replace:

```typescript
  const pieValues = Array.from(modelTotalsMap.entries())
    .map(([model, stats]) => ({
      type: model,
      value: getMetricValue(stats),
    }))
    .sort((a, b) => b.value - a.value)
```

- [ ] **Step 7: Update spec_model_line (trend) to use metric**

The `modelLineValues` (lines 404-430) currently use `stats.count`. Replace the `Count` field with metric-aware value. Replace lines 404-431:

```typescript
  const modelLineValues: Array<{
    Time: string
    Model: string
    Count: number
  }> = []
  chartTimes.forEach((time) => {
    const timeData = topTrendModels.map((model) => {
      const stats = timeModelMap.get(time)?.get(model)
      return {
        Time: time,
        Model: model,
        Count: getMetricValue(stats || { quota: 0, count: 0, tokens: 0 }),
      }
    })
    if (otherTrendModels.length > 0) {
      const otherCount = otherTrendModels.reduce((sum, model) => {
        const stats = timeModelMap.get(time)?.get(model)
        return sum + getMetricValue(stats || { quota: 0, count: 0, tokens: 0 })
      }, 0)
      timeData.push({
        Time: time,
        Model: otherLabel,
        Count: otherCount,
      })
    }
    modelLineValues.push(...timeData)
  })
  modelLineValues.sort((a, b) => a.Time.localeCompare(b.Time))
```

- [ ] **Step 8: Update rank bar to use metric**

The `allRankValues` (lines 435-440) currently sort by `Count` (count). Replace:

```typescript
  const allRankValues = Array.from(modelTotalsMap.entries())
    .map(([model, stats]) => ({
      Model: model,
      Count: getMetricValue(stats),
    }))
    .sort((a, b) => b.Count - a.Count)
```

- [ ] **Step 9: Update totalTokens calculation and return**

After `totalQuotaRaw` (line 305), add:

```typescript
  const totalTokensRaw = Array.from(modelTotalsMap.values()).reduce(
    (sum, x) => sum + (Number(x.tokens) || 0),
    0
  )
```

In the return object (line 686-688), add `totalTokensDisplay`:

```typescript
    totalQuotaDisplay: formatQuotaTotal(totalQuotaRaw),
    totalTokensDisplay: formatTokens(totalTokensRaw),
    totalCountDisplay: formatInt(totalTimes),
```

- [ ] **Step 10: Update spec tooltip formatters to use metric**

The `spec_line` tooltip (lines 505-525) and `spec_area` tooltip (lines 538-559) use `formatQuotaValue`. The `spec_model_line` tooltip (lines 590-637) and `spec_rank_bar` tooltip (lines 672-681) use `formatInt`.

For `spec_line` and `spec_area`, replace `formatQuotaValue(Number(datum?.rawQuota) || 0)` with `formatMetric(Number(datum?.rawQuota) || 0)` in both the mark content and dimension content. Note: `formatMetric` will use `formatQuotaValue` for quota metric and `formatTokens` for tokens/calls.

For `spec_model_line` and `spec_rank_bar`, replace `formatInt(Number(datum?.Count) || 0)` with `formatMetric(Number(datum?.Count) || 0)`.

Also update `makeTooltipDimensionUpdateContent` calls — the `formatQuotaValue` references inside should become `formatMetric`. However, `makeTooltipDimensionUpdateContent` is defined before the metric param is available. Move the `formatMetric`/`getMetricValue` definitions before `makeTooltipDimensionUpdateContent`, or pass the formatter as a parameter.

Simplest approach: move the metric helper definitions (Step 2) to before `makeTooltipDimensionUpdateContent` (before line 84), and replace `formatQuotaValue` inside `makeTooltipDimensionUpdateContent` with `formatMetric`.

- [ ] **Step 11: Update spec titles to be metric-aware**

The `spec_pie` title (line 472) is `tt('Call Count Distribution')`. Make it metric-aware:

```typescript
        text: metric === 'quota' ? tt('Quota Distribution') : metric === 'tokens' ? tt('Token Distribution') : tt('Call Count Distribution'),
```

The `spec_model_line` title (line 588) is `tt('Call Trend')`. Make it metric-aware:

```typescript
        text: metric === 'quota' ? tt('Quota Trend') : metric === 'tokens' ? tt('Token Trend') : tt('Call Trend'),
```

The `spec_rank_bar` title (line 665) is `tt('Call Count Ranking')`. Make it metric-aware:

```typescript
        text: metric === 'quota' ? tt('Quota Ranking') : metric === 'tokens' ? tt('Token Ranking') : tt('Call Count Ranking'),
```

- [ ] **Step 12: Verify frontend builds (will fail — chart components don't accept metric prop yet)**

Run: `cd web && bun run build`
Expected: FAIL — chart components pass `metric` prop but don't declare it. Expected; Task 12 fixes it.

- [ ] **Step 13: Commit**

```bash
git add web/src/features/dashboard/lib/charts.ts
git commit -m "feat: extend processChartData with Quota/Tokens/Calls metric support"
```

---

## Task 9: Chart components accept metric prop

**Files:**
- Modify: `web/src/features/dashboard/components/models/consumption-distribution-chart.tsx:44-59`
- Modify: `web/src/features/dashboard/components/models/model-charts.tsx:52-108`

- [ ] **Step 1: Add metric prop to ConsumptionDistributionChart**

In `web/src/features/dashboard/components/models/consumption-distribution-chart.tsx`, add import:

```typescript
import type {
  ConsumptionDistributionChartType,
  ModelAnalyticsMetric,
  QuotaDataItem,
} from '@/features/dashboard/types'
```

Add `metric` to the props interface (around line 44-49):

```typescript
interface ConsumptionDistributionChartProps {
  data: QuotaDataItem[]
  loading?: boolean
  defaultChartType?: ConsumptionDistributionChartType
  timeGranularity?: TimeGranularity
  metric?: ModelAnalyticsMetric
}
```

Pass `metric` to `processChartData` (around line 101-108):

```typescript
  const chartData = useMemo(
    () =>
      processChartData(
        props.loading ? [] : props.data,
        timeGranularity,
        t,
        chartRadius,
        props.metric ?? 'quota'
      ),
    [props.data, props.loading, timeGranularity, t, chartRadius, props.metric]
  )
```

Update the title and total display (around lines 129-132):

```tsx
          <div className='text-sm font-semibold'>
            {t(
              props.metric === 'tokens'
                ? 'Token Distribution'
                : props.metric === 'calls'
                  ? 'Call Distribution'
                  : 'Quota Distribution'
            )}
          </div>
          <span className='text-muted-foreground text-xs'>
            {t('Total:')}{' '}
            {props.metric === 'tokens'
              ? chartData.totalTokensDisplay
              : props.metric === 'calls'
                ? chartData.totalCountDisplay
                : chartData.totalQuotaDisplay}
          </span>
```

- [ ] **Step 2: Add metric prop to ModelCharts**

In `web/src/features/dashboard/components/models/model-charts.tsx`, add `ModelAnalyticsMetric` to the type import (line 33):

```typescript
import type {
  ModelAnalyticsChartTab,
  ModelAnalyticsMetric,
  QuotaDataItem,
} from '@/features/dashboard/types'
```

Add `metric` to props interface (line 52-57):

```typescript
interface ModelChartsProps {
  data: QuotaDataItem[]
  loading?: boolean
  timeGranularity?: TimeGranularity
  defaultChartTab?: ModelAnalyticsChartTab
  metric?: ModelAnalyticsMetric
}
```

Pass `metric` to `processChartData` (lines 99-108):

```typescript
  const chartData = useMemo(
    () =>
      processChartData(
        props.loading ? [] : props.data,
        timeGranularity,
        t,
        chartRadius,
        props.metric ?? 'quota'
      ),
    [props.data, props.loading, timeGranularity, t, chartRadius, props.metric]
  )
```

Update the total display (line 132):

```tsx
          <span className='text-muted-foreground text-xs'>
            {t('Total:')}{' '}
            {props.metric === 'tokens'
              ? chartData.totalTokensDisplay
              : props.metric === 'calls'
                ? chartData.totalCountDisplay
                : chartData.totalQuotaDisplay}
          </span>
```

- [ ] **Step 3: Verify frontend builds**

Run: `cd web && bun run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/features/dashboard/components/models/consumption-distribution-chart.tsx web/src/features/dashboard/components/models/model-charts.tsx
git commit -m "feat: pass metric prop to chart components"
```

---

## Task 10: Add token card to user overview summary

**Files:**
- Modify: `web/src/features/dashboard/hooks/use-dashboard-config.tsx:93-129`
- Modify: `web/src/features/dashboard/components/overview/summary-cards.tsx:145-171`

- [ ] **Step 1: Add usedTokens to useSummaryCardsConfig signature**

In `web/src/features/dashboard/hooks/use-dashboard-config.tsx`, change the `useSummaryCardsConfig` function (lines 93-99) to accept `usedTokens`:

```typescript
export function useSummaryCardsConfig(totals: {
  todayUsageDisplay: string
  usedDisplay: string
  requestCountDisplay: string
  usedTokensDisplay: string
  currencyLabel: string
  currencyEnabled: boolean
}) {
```

Add the token card to the returned array (after the `requests` card, before the closing `]`):

```typescript
    {
      key: 'tokens',
      title: t('Total Tokens'),
      value: totals.usedTokensDisplay,
      description: t('Total consumed tokens'),
      icon: Layers,
    },
```

Add `Layers` to the lucide-react import (line 19-29 area, it's already imported).

- [ ] **Step 2: Pass usedTokens to useSummaryCardsConfig in SummaryCards**

In `web/src/features/dashboard/components/overview/summary-cards.tsx`, after line 147 (`const requestCount = Number(user?.request_count ?? 0)`), add:

```typescript
  const usedTokens = Number(user?.used_tokens ?? 0)
```

Update `summaryValues` (lines 166-171):

```typescript
  const summaryValues = useMemo(() => {
    return {
      usedDisplay: formatQuota(usedQuota),
      requestCountDisplay: formatNumber(requestCount),
      usedTokensDisplay: formatCompactNumber(usedTokens),
    }
  }, [requestCount, usedQuota, usedTokens])
```

`formatCompactNumber` is already imported (line 36).

- [ ] **Step 3: Update the items mapping to handle 4 cards**

In `summary-cards.tsx` (line 235), the `tones` array has 3 entries. Extend to 4:

```typescript
    const tones = ['accent-1', 'accent-2', 'accent-3', 'chart-4'] as const
```

- [ ] **Step 4: Verify frontend builds**

Run: `cd web && bun run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/features/dashboard/hooks/use-dashboard-config.tsx web/src/features/dashboard/components/overview/summary-cards.tsx
git commit -m "feat: add token consumption card to user overview summary"
```

---

## Task 11: i18n sync

**Files:**
- Modify: `web/src/i18n/locales/{en,zh,zh-TW,fr,ru,ja,vi}.json`

- [ ] **Step 1: Run i18n sync**

Run: `cd web && bun run i18n:sync`
Expected: New keys detected and added to locale files.

- [ ] **Step 2: Fill in translations for new keys**

New keys to translate (English is the key itself):
- `Tokens:`
- `Token Distribution`
- `Call Distribution`
- `Quota Distribution`
- `Quota Trend`
- `Token Trend`
- `Call Trend`
- `Quota Ranking`
- `Token Ranking`
- `Call Count Ranking`
- `Calls`
- `Total consumed tokens`

Check `web/src/i18n/locales/zh.json` for these keys and fill in Chinese translations. Some keys like `Tokens`, `Quota`, `Total Tokens` already exist.

- [ ] **Step 3: Verify frontend builds**

Run: `cd web && bun run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/i18n/locales/
git commit -m "feat: add i18n translations for token usage stats"
```

---

## Task 12: End-to-end verification

- [ ] **Step 1: Verify backend compiles and tests pass**

Run: `go build ./... && go test ./model/ -v -count=1`
Expected: PASS

- [ ] **Step 2: Verify relaykit module builds independently**

Run: `cd relaykit && GOWORK=off go build ./...`
Expected: PASS (relaykit should not be affected by these changes)

- [ ] **Step 3: Verify frontend builds**

Run: `cd web && bun run build`
Expected: PASS

- [ ] **Step 4: Smoke test — start server and verify migration**

Start the server, check logs for `ALTER TABLE users ADD COLUMN used_tokens` and `ALTER TABLE channels ADD COLUMN used_tokens`.

- [ ] **Step 5: Smoke test — send a text request and verify token accumulation**

Send a chat completion request. Query `SELECT used_tokens FROM users WHERE id = <user_id>` and `SELECT used_tokens FROM channels WHERE id = <channel_id>`. Verify the values match `prompt_tokens + completion_tokens` from the log.

- [ ] **Step 6: Smoke test — verify UI tooltips**

Open `/console/user` in browser, hover over a user status badge, verify tooltip shows both Requests and Tokens. Open `/console/channel`, hover over a channel status badge, verify tooltip shows Tokens. Open `/console` dashboard, switch to models section, verify Quota/Tokens/Calls toggle switches both charts' metrics.

- [ ] **Step 7: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address verification findings"
```
