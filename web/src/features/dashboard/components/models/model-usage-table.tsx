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
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import {
  StaticDataTable,
  staticDataTableClassNames as tableStyles,
} from '@/components/data-table'
import { Skeleton } from '@/components/ui/skeleton'
import {
  aggregateModelUsage,
  type ModelUsageRow,
} from '@/features/dashboard/lib/model-usage'
import type { QuotaDataItem } from '@/features/dashboard/types'
import { formatNumber, formatQuota } from '@/lib/format'

interface ModelUsageTableProps {
  data: QuotaDataItem[]
  loading?: boolean
}

export function ModelUsageTable(props: ModelUsageTableProps) {
  const { t } = useTranslation()
  const rows = useMemo(() => aggregateModelUsage(props.data), [props.data])
  const columns = useMemo(
    () => [
      {
        id: 'model',
        header: t('Model'),
        className: tableStyles.compactHeaderCell,
        cellClassName: tableStyles.mediumCell,
        cell: (row: ModelUsageRow) => row.modelName || t('Unknown'),
      },
      {
        id: 'total-tokens',
        header: t('Total Tokens'),
        className: tableStyles.compactHeaderCellRight,
        cellClassName: tableStyles.compactNumericCell,
        cell: (row: ModelUsageRow) => formatNumber(row.totalTokens),
      },
      {
        id: 'input-tokens',
        header: t('Input Tokens'),
        className: tableStyles.compactHeaderCellRight,
        cellClassName: tableStyles.compactNumericCell,
        cell: (row: ModelUsageRow) => formatNumber(row.inputTokens),
      },
      {
        id: 'output-tokens',
        header: t('Output Tokens'),
        className: tableStyles.compactHeaderCellRight,
        cellClassName: tableStyles.compactNumericCell,
        cell: (row: ModelUsageRow) => formatNumber(row.outputTokens),
      },
      {
        id: 'cache-read',
        header: t('Cache Read'),
        className: tableStyles.compactHeaderCellRight,
        cellClassName: tableStyles.compactNumericCell,
        cell: (row: ModelUsageRow) => formatNumber(row.cacheReadTokens),
      },
      {
        id: 'cache-write',
        header: t('Cache Write'),
        className: tableStyles.compactHeaderCellRight,
        cellClassName: tableStyles.compactNumericCell,
        cell: (row: ModelUsageRow) => formatNumber(row.cacheWriteTokens),
      },
      {
        id: 'requests',
        header: t('Request Count'),
        className: tableStyles.compactHeaderCellRight,
        cellClassName: tableStyles.compactNumericCell,
        cell: (row: ModelUsageRow) => formatNumber(row.requestCount),
      },
      {
        id: 'quota',
        header: t('Quota'),
        className: tableStyles.compactHeaderCellRight,
        cellClassName: tableStyles.compactNumericCell,
        cell: (row: ModelUsageRow) => formatQuota(row.quota),
      },
    ],
    [t]
  )

  return (
    <div className='overflow-hidden rounded-lg border'>
      <div className='border-b px-3 py-2 sm:px-5 sm:py-3'>
        <div className='text-sm font-semibold'>{t('Token Breakdown')}</div>
      </div>
      {props.loading ? (
        <div className='space-y-2 p-3 sm:p-5'>
          <Skeleton className='h-8 w-full' />
          <Skeleton className='h-8 w-full' />
          <Skeleton className='h-8 w-full' />
        </div>
      ) : (
        <StaticDataTable
          className='overflow-x-auto rounded-none border-0'
          tableClassName='min-w-[900px] text-sm'
          columns={columns}
          data={rows}
          getRowKey={(row) => row.modelName}
          headerRowClassName={tableStyles.compactHeaderRow}
          emptyContent={t('No data available')}
        />
      )}
    </div>
  )
}
