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
import type { QuotaDataItem } from '@/features/dashboard/types'

export interface ModelUsageRow {
  modelName: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requestCount: number
  quota: number
}

export function aggregateModelUsage(data: QuotaDataItem[]): ModelUsageRow[] {
  const byModel = new Map<string, ModelUsageRow>()

  for (const item of data) {
    const modelName = item.model_name || ''
    const current = byModel.get(modelName) ?? {
      modelName,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requestCount: 0,
      quota: 0,
    }
    current.totalTokens += Number(item.token_used) || 0
    current.inputTokens += Number(item.input_tokens) || 0
    current.outputTokens += Number(item.output_tokens) || 0
    current.cacheReadTokens += Number(item.cache_read_tokens) || 0
    current.cacheWriteTokens += Number(item.cache_write_tokens) || 0
    current.requestCount += Number(item.count) || 0
    current.quota += Number(item.quota) || 0
    byModel.set(modelName, current)
  }

  return [...byModel.values()].sort(
    (left, right) => right.totalTokens - left.totalTokens
  )
}
