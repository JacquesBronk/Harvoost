'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Building2,
  Calendar,
  ClipboardCheck,
  GanttChartSquare,
  Inbox,
  LayoutDashboard,
  LineChart,
  LogOut,
  MessageSquare,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  Warehouse,
} from 'lucide-react';
import { type ReactNode } from 'react';
import { Avatar, Badge, LoadingSpinner } from '@harvoost/ui';
import { useScope } from '@/lib/rbac.js';
import { resolveAuthGate, useCurrentUser } from '@/lib/auth.js';
import { requestLogout, resolveLogoutNavigation } from '@/lib/logout.js';
import { TimerBar } from './TimerBar.js';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  visible: (scope: ReturnType<typeof useScope>) => boolean;
}

const navItems: NavItem[] = [
  { href: '/timesheets', label: 'Timesheets', icon: Timer, visible: (s) => s.isAuthed },
  {
    href: '/dashboard',
    label: 'Team',
    icon: LayoutDashboard,
    visible: (s) => s.canApproveStage1 || s.canApproveStage2,
  },
  {
    href: '/approvals',
    label: 'Approvals',
    icon: ClipboardCheck,
    visible: (s) => s.canApproveStage1 || s.canApproveStage2,
  },
  { href: '/leave', label: 'Leave', icon: Calendar, visible: (s) => s.isAuthed },
  {
    href: '/schedule',
    label: 'Schedule',
    icon: GanttChartSquare,
    visible: (s) => s.isAuthed,
  },
  {
    href: '/exceptions',
    label: 'Exceptions',
    icon: Inbox,
    visible: (s) => s.isAuthed,
  },
  { href: '/chat', label: 'Assistant', icon: MessageSquare, visible: (s) => s.isAuthed },
  {
    href: '/financial',
    label: 'Financial',
    icon: LineChart,
    visible: (s) => s.canSeeFinancialData,
  },
  { href: '/admin/users', label: 'Users', icon: Users, visible: (s) => s.isAdmin },
  {
    href: '/admin/clients',
    label: 'Clients',
    icon: Building2,
    visible: (s) => s.canSeeFinancialData,
  },
  {
    href: '/admin/projects',
    label: 'Projects',
    icon: Warehouse,
    visible: (s) => s.isAdmin,
  },
  {
    href: '/admin/rates',
    label: 'Rates',
    icon: ShieldCheck,
    visible: (s) => s.canSeeFinancialData,
  },
  { href: '/settings', label: 'Settings', icon: Settings, visible: (s) => s.isAuthed },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const scope = useScope();
  const { data: user, isLoading, isError } = useCurrentUser();

  // INC-003: treat loading AND transient errors (429/5xx/network) as "still
  // resolving" — keep the spinner so the auth query can back off and recover.
  // Only a genuine `null` (mapped 401/403) means "not signed in"; dropping the
  // shell on a transient error is what fed the redirect → remount → refetch storm.
  const decision = resolveAuthGate({ user, isLoading, isError });

  if (decision.kind === 'wait') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingSpinner size="lg" label="Loading Harvoost" />
      </div>
    );
  }

  if (decision.kind === 'login') {
    // Not signed in — render children directly (login flow handles its own layout).
    return <>{children}</>;
  }

  const { user: currentUser } = decision;

  // INC-002 defense-in-depth: backend guarantees a non-empty display_name, but
  // fall back to the email so the shell can never render a blank identity.
  const displayName = currentUser.display_name?.trim()
    ? currentUser.display_name
    : currentUser.email;

  async function handleSignOut() {
    // INC-008 (GitHub #11): revoke the local session, then end the IdP SSO
    // session via RP-initiated logout. requestLogout preserves the CSRF +
    // cookie behavior and returns `null` on any failure.
    const response = await requestLogout();
    const nav = resolveLogoutNavigation(response);
    if (nav.kind === 'external') {
      // A REAL full-page navigation to the IdP end_session_endpoint — NOT
      // router.push — so the external IdP origin clears the SSO cookie and then
      // redirects back to the web /login per post_logout_redirect_uri.
      window.location.assign(nav.url);
      return;
    }
    // No usable IdP logout URL (null / non-http(s)) or the request failed —
    // fall back to a local redirect so the user is never stranded.
    router.push('/login');
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 lg:flex-row">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      {/* Sidebar */}
      <aside
        aria-label="Primary navigation"
        className="z-30 flex w-full shrink-0 flex-col border-b border-neutral-200 bg-white lg:h-screen lg:w-60 lg:border-b-0 lg:border-r lg:sticky lg:top-0"
      >
        <div className="flex items-center justify-between px-4 py-3 lg:py-4">
          <Link
            href="/timesheets"
            className="flex items-center gap-2 text-base font-semibold text-neutral-900"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-white">
              <Timer className="h-4 w-4" aria-hidden="true" />
            </span>
            Harvoost
          </Link>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-x-auto px-2 pb-2 lg:overflow-y-auto lg:overflow-x-visible">
          <ul className="flex flex-row gap-1 lg:flex-col lg:gap-0.5">
            {navItems
              .filter((item) => item.visible(scope))
              .map((item) => {
                const active =
                  pathname === item.href || pathname?.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <li key={item.href} className="shrink-0 lg:shrink">
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={`inline-flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                        active
                          ? 'bg-brand-50 text-brand-700 font-medium'
                          : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
          </ul>
        </nav>

        <div className="mt-auto hidden border-t border-neutral-100 px-3 py-3 lg:block">
          <div className="flex items-center gap-2">
            <Avatar name={displayName} size="md" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-neutral-900">
                {displayName}
              </div>
              <div className="truncate text-xs text-neutral-500">
                {currentUser.email}
              </div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {currentUser.roles.map((r) => (
              <Badge key={r} tone="neutral" className="capitalize">
                {r}
              </Badge>
            ))}
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TimerBar />
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
