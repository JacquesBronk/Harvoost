'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Card,
  EmptyState,
  LoadingSpinner,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@harvoost/ui';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PageHeader } from '@/components/PageHeader.js';
import { ErrorBlock } from '@/components/ErrorBlock.js';
import { apiFetch } from '@/lib/api-client.js';
import { formatHours } from '@/lib/tz.js';
import { useScope } from '@/lib/rbac.js';
import type { FinancialProjectRow, Paginated } from '@/lib/api-types.js';

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export default function FinancialPage() {
  const scope = useScope();
  const router = useRouter();
  const toast = useToast();

  useEffect(() => {
    if (!scope.isLoading && scope.user && !scope.canSeeFinancialData) {
      toast.info(
        'Restricted',
        'Financial dashboards are limited to Admin and Financial Manager roles.',
      );
      router.replace('/timesheets');
    }
    // We intentionally depend only on the boolean flags so we don't re-fire on
    // every scope object identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.isLoading, scope.user, scope.canSeeFinancialData]);

  const profitability = useQuery({
    queryKey: ['financial', 'projects'],
    queryFn: () =>
      apiFetch<Paginated<FinancialProjectRow>>('/v1/reports/profitability', {
        query: { group_by: 'project', limit: 100 },
      }),
    enabled: scope.canSeeFinancialData,
  });

  const rows = profitability.data?.items ?? [];

  if (!scope.canSeeFinancialData) {
    return null;
  }

  return (
    <div>
      <PageHeader
        title="Financial dashboard"
        description="Margin per project. Cost rates are point-in-time; revenue follows the project's billing mode."
      />

      <Card title="Projects by margin" padded={false}>
        {profitability.isLoading ? (
          <div className="px-4 py-8 text-center">
            <LoadingSpinner size="md" label="Loading profitability" />
          </div>
        ) : profitability.isError ? (
          <div className="px-4 py-4">
            <ErrorBlock
              error={profitability.error}
              onRetry={() => profitability.refetch()}
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8">
            <EmptyState
              title="No financial data yet"
              description="Once time entries are logged against active projects, profitability will appear here."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Project</TH>
                <TH>Client</TH>
                <TH>Mode</TH>
                <TH className="text-right">Hours</TH>
                <TH className="text-right">Revenue</TH>
                <TH className="text-right">Cost</TH>
                <TH className="text-right">Margin</TH>
                <TH className="text-right">Margin %</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.project_id}>
                  <TD className="font-medium text-neutral-900">{r.project_name}</TD>
                  <TD>{r.client_name ?? '—'}</TD>
                  <TD>
                    <Badge
                      tone={
                        r.billing_mode === 'hourly'
                          ? 'info'
                          : r.billing_mode === 'fixed_fee'
                            ? 'brand'
                            : 'neutral'
                      }
                    >
                      {r.billing_mode.replace('_', ' ')}
                    </Badge>
                  </TD>
                  <TD className="text-right font-mono">{formatHours(r.hours)}</TD>
                  <TD className="text-right font-mono">
                    {fmtMoney(r.revenue, r.currency)}
                  </TD>
                  <TD className="text-right font-mono">
                    {fmtMoney(r.cost, r.currency)}
                  </TD>
                  <TD className="text-right font-mono">
                    {fmtMoney(r.margin, r.currency)}
                  </TD>
                  <TD className="text-right">
                    <Badge tone={r.margin_pct >= 0.2 ? 'success' : r.margin_pct >= 0 ? 'warning' : 'danger'}>
                      {(r.margin_pct * 100).toFixed(1)}%
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
