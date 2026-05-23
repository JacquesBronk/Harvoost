import type { ReactNode } from 'react';
import { Card, EmptyState } from '@harvoost/ui';
import { Construction } from 'lucide-react';

// A consistent "coming soon" panel for MVP stub pages. Communicates that
// the screen exists in the navigation but the underlying interaction has
// not been wired yet. Keep this stub-only — don't use for genuine empty states.

export function StubSection({
  title,
  description,
  extra,
}: {
  title: string;
  description: string;
  extra?: ReactNode;
}) {
  return (
    <Card title={title}>
      <EmptyState
        icon={<Construction className="h-5 w-5" aria-hidden="true" />}
        title="Coming soon"
        description={description}
      />
      {extra}
    </Card>
  );
}
