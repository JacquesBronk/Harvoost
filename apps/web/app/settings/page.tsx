'use client';

import { Card, LoadingSpinner } from '@harvoost/ui';
import { PageHeader } from '@/components/PageHeader.js';
import { useCurrentUser } from '@/lib/auth.js';

// TODO(build-phase-followup): wire the timezone picker + weekly_summary_opt_out
// toggle to PATCH /v1/users/:id. Use react-hook-form + Zod for validation.

export default function SettingsPage() {
  const { data: user, isLoading } = useCurrentUser();

  if (isLoading) {
    return <LoadingSpinner size="md" label="Loading settings" />;
  }
  if (!user) return null;

  return (
    <div>
      <PageHeader title="Settings" description="Your profile and preferences." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profile">
          <dl className="grid grid-cols-3 gap-y-2 text-sm">
            <dt className="text-neutral-500">Name</dt>
            <dd className="col-span-2 font-medium text-neutral-900">
              {user.display_name}
            </dd>
            <dt className="text-neutral-500">Email</dt>
            <dd className="col-span-2 text-neutral-900">{user.email}</dd>
            <dt className="text-neutral-500">Timezone</dt>
            <dd className="col-span-2 font-mono text-neutral-900">{user.timezone}</dd>
            <dt className="text-neutral-500">Roles</dt>
            <dd className="col-span-2 capitalize text-neutral-900">
              {user.roles.join(', ')}
            </dd>
          </dl>
        </Card>

        <Card title="Preferences">
          <p className="text-sm text-neutral-500">
            Weekly summary opt-out and timezone editing UI coming soon.
          </p>
        </Card>
      </div>
    </div>
  );
}
