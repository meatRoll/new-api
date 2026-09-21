/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { aggregateModelUsage } from '../model-usage'

describe('model usage aggregation', () => {
  test('aggregates token breakdowns by model and sorts by total tokens', () => {
    const rows = aggregateModelUsage([
      {
        created_at: 1,
        model_name: 'model-a',
        token_used: 30,
        input_tokens: 20,
        output_tokens: 10,
        cache_read_tokens: 5,
        cache_write_tokens: 2,
        count: 1,
        quota: 40,
      },
      {
        created_at: 2,
        model_name: 'model-b',
        token_used: 60,
        input_tokens: 40,
        output_tokens: 20,
        cache_read_tokens: 8,
        cache_write_tokens: 4,
        count: 3,
        quota: 90,
      },
      {
        created_at: 3,
        model_name: 'model-a',
        token_used: 25,
        input_tokens: 15,
        output_tokens: 10,
        cache_read_tokens: 3,
        cache_write_tokens: 1,
        count: 2,
        quota: 35,
      },
    ])

    assert.deepEqual(rows, [
      {
        modelName: 'model-b',
        totalTokens: 60,
        inputTokens: 40,
        outputTokens: 20,
        cacheReadTokens: 8,
        cacheWriteTokens: 4,
        requestCount: 3,
        quota: 90,
      },
      {
        modelName: 'model-a',
        totalTokens: 55,
        inputTokens: 35,
        outputTokens: 20,
        cacheReadTokens: 8,
        cacheWriteTokens: 3,
        requestCount: 3,
        quota: 75,
      },
    ])
  })
})
