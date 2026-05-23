import { ShieldCheck, Users } from 'lucide-react';
import type { ScopeMeta } from '@/lib/api-types.js';

// Shows the requester's visibility summary as returned by `scope_meta`
// on every scoped list endpoint. Renders an unrestricted ("all") badge
// for Admin/FinMgr (signalled by -1 sentinel) per API_NOTES.md.

export function ScopeMetaIndicator({ scopeMeta }: { scopeMeta: ScopeMeta | undefined }) {
  if (!scopeMeta) return null;
  const allUsers = scopeMeta.visible_users === -1;
  const allProjects = scopeMeta.visible_projects === -1;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
      <span className="inline-flex items-center gap-1">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        {allUsers ? 'All users' : `${scopeMeta.visible_users} visible users`}
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {allProjects ? 'All projects' : `${scopeMeta.visible_projects} visible projects`}
      </span>
    </div>
  );
}
