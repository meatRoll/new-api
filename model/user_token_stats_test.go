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

func setupTokenStatsBatchTestState(t *testing.T) {
	t.Helper()
	truncateTables(t)
	require.NoError(t, DB.Exec("DELETE FROM users").Error)
	require.NoError(t, DB.Exec("DELETE FROM channels").Error)

	// Clear any leftover batch store entries so batchUpdate() only flushes
	// data enqueued by this test.
	for i := 0; i < BatchUpdateTypeCount; i++ {
		batchUpdateLocks[i].Lock()
		batchUpdateStores[i] = make(map[int]int)
		batchUpdateLocks[i].Unlock()
	}

	oldRedisEnabled := common.RedisEnabled
	oldBatchUpdateEnabled := common.BatchUpdateEnabled
	common.RedisEnabled = false
	common.BatchUpdateEnabled = true
	t.Cleanup(func() {
		common.RedisEnabled = oldRedisEnabled
		common.BatchUpdateEnabled = oldBatchUpdateEnabled
	})
}

func TestBatchUpdateUserUsedTokens(t *testing.T) {
	setupTokenStatsBatchTestState(t)

	user := User{
		Id:         1,
		Username:   "batch-token-stats-user",
		Password:   "password",
		Status:     common.UserStatusEnabled,
		Quota:      10000,
		UsedQuota:  100,
		UsedTokens: 500,
	}
	require.NoError(t, DB.Create(&user).Error)

	// Enqueue to batch stores via the exported function.
	UpdateUserUsedQuotaAndRequestCount(user.Id, 200, 1500)

	// Flush all batch stores to the DB (same package).
	batchUpdate()

	var got User
	require.NoError(t, DB.First(&got, user.Id).Error)
	assert.Equal(t, 300, got.UsedQuota, "used_quota should accumulate via batch")
	assert.Equal(t, int64(2000), got.UsedTokens, "used_tokens should accumulate via batch")
	assert.Equal(t, 1, got.RequestCount, "request_count should increment by 1 via batch")
}

func TestBatchUpdateChannelUsedTokens(t *testing.T) {
	setupTokenStatsBatchTestState(t)

	ch := Channel{
		Id:         1,
		Name:       "batch-token-stats-channel",
		Type:       1,
		Status:     1,
		UsedQuota:  100,
		UsedTokens: 500,
	}
	require.NoError(t, DB.Create(&ch).Error)

	// Enqueue to batch stores via the exported function.
	UpdateChannelUsedQuota(ch.Id, 200, 1500)

	// Flush all batch stores to the DB (same package).
	batchUpdate()

	var got Channel
	require.NoError(t, DB.First(&got, ch.Id).Error)
	assert.Equal(t, int64(300), got.UsedQuota, "used_quota should accumulate via batch")
	assert.Equal(t, int64(2000), got.UsedTokens, "used_tokens should accumulate via batch")
}
