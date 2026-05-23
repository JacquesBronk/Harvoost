/**
 * Harvoost dev/test seed.
 *
 * Idempotent: re-running this script does NOT duplicate rows — it upserts on
 * stable keys (email for users, code for projects, name for clients).
 *
 * Writes:
 *   - org_settings singleton (already inserted by the init migration; updated here)
 *   - admin_email_allowlist with BOOTSTRAP_ADMIN_EMAIL
 *   - All users from RBAC_TEST_FIXTURE (admin, finmgr, 3 managers, 4 employees)
 *   - user_roles per fixture
 *   - 1 demo client + 4 projects
 *   - project_members, project_managers, project_tasks
 *   - user_managers (Alice → Bob)
 *   - employee_cost_rates and project_billable_rates with effective_from = today
 *   - schedule_templates (default 08:00-17:00 Mon-Fri) for every fixture user
 *   - A small sprinkle of sample time_entries from last week so dashboards
 *     aren't blank on first boot
 *
 * Run via:
 *   pnpm --filter @harvoost/db seed
 *   (or `pnpm db:seed` from the repo root)
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { RBAC_TEST_FIXTURE } from '../src/fixtures.js';

const prisma = new PrismaClient();

// Deterministic fake Entra object ID derived from the email — keeps seeding
// idempotent across runs while still giving each user a stable, unique value.
function fakeEntraObjectId(email: string): string {
  return `dev-oid-${email.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
}

const DEFAULT_BOOTSTRAP_EMAIL = 'admin@harvoost.local';

async function main(): Promise<void> {
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL ?? DEFAULT_BOOTSTRAP_EMAIL;
  console.log(`[seed] BOOTSTRAP_ADMIN_EMAIL = ${adminEmail}`);

  // ----- org_settings: refresh with explicit values (singleton, id=1) -----
  await prisma.orgSetting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      reportingCurrency: RBAC_TEST_FIXTURE.currency,
      defaultTimezone: 'Africa/Johannesburg',
    },
    update: {
      reportingCurrency: RBAC_TEST_FIXTURE.currency,
      defaultTimezone: 'Africa/Johannesburg',
    },
  });
  console.log('[seed] org_settings ok');

  // ----- admin_email_allowlist -----
  await prisma.adminEmailAllowlist.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, addedBy: 'seed-script' },
    update: {},
  });
  console.log(`[seed] admin_email_allowlist ok (${adminEmail})`);

  // ----- Users + roles -----
  const usersByKey = new Map<string, { id: bigint; email: string }>();
  for (const u of RBAC_TEST_FIXTURE.users) {
    // The admin's email is overridden by env if it differs from the fixture default.
    const email = u.key === 'admin' ? adminEmail : u.email;
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        entraObjectId: fakeEntraObjectId(email),
        email,
        displayName: u.displayName,
        timezone: u.timezone,
        weeklySummaryOptOut: true, // seed users opt out so dev runs don't blast emails
        isActive: true,
      },
      update: {
        displayName: u.displayName,
        timezone: u.timezone,
      },
    });
    usersByKey.set(u.key, { id: user.id, email: user.email });

    // Roles — upsert each (user_id, role) tuple.
    for (const role of u.roles) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId: user.id, role } },
        create: { userId: user.id, role, assignedBy: null },
        update: {},
      });
    }
  }
  console.log(`[seed] users + roles ok (${usersByKey.size})`);

  // ----- Schedule templates (default 08-17 Mon-Fri) -----
  for (const [, u] of usersByKey) {
    await prisma.scheduleTemplate.upsert({
      where: { userId: u.id },
      create: { userId: u.id },
      update: {},
    });
  }
  console.log('[seed] schedule_templates ok');

  // ----- Client -----
  // Clients have no natural unique key in the schema; use findFirst+create idiom.
  let client = await prisma.client.findFirst({ where: { name: RBAC_TEST_FIXTURE.client.name } });
  if (!client) {
    client = await prisma.client.create({
      data: { name: RBAC_TEST_FIXTURE.client.name, isActive: true },
    });
  }
  console.log(`[seed] client ok (${client.name})`);

  // ----- Projects + tasks + members + managers + billable rates -----
  const projectsByKey = new Map<string, { id: bigint; code: string }>();
  const today = new Date();
  const todayDateOnly = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  // First user with admin role becomes the "created_by" for rates etc.
  const adminUser = usersByKey.get('admin');
  if (!adminUser) throw new Error('admin user not found after upsert — fixture invariant violated');

  for (const p of RBAC_TEST_FIXTURE.projects) {
    const project = await prisma.project.upsert({
      where: { code: p.code },
      create: {
        clientId: client.id,
        code: p.code,
        name: p.name,
        billingMode: p.billingMode,
        currency: p.currency,
        fixedFeeAmount: p.fixedFeeAmount != null ? new Prisma.Decimal(p.fixedFeeAmount) : null,
        hoursBudget: p.hoursBudget != null ? new Prisma.Decimal(p.hoursBudget) : null,
        isActive: true,
      },
      update: {
        name: p.name,
        billingMode: p.billingMode,
        currency: p.currency,
      },
    });
    projectsByKey.set(p.key, { id: project.id, code: project.code ?? p.code });

    // Default task per project
    const defaultTaskName = 'General';
    const existingTask = await prisma.projectTask.findFirst({
      where: { projectId: project.id, name: defaultTaskName, isActive: true },
    });
    if (!existingTask) {
      await prisma.projectTask.create({
        data: {
          projectId: project.id,
          name: defaultTaskName,
          isBillable: p.billingMode === 'hourly',
          isActive: true,
        },
      });
    }

    // Members
    for (const memberKey of p.memberKeys) {
      const memberUser = usersByKey.get(memberKey);
      if (!memberUser) throw new Error(`fixture refs missing member ${memberKey}`);
      const existingMember = await prisma.projectMember.findFirst({
        where: { projectId: project.id, userId: memberUser.id, leftAt: null },
      });
      if (!existingMember) {
        await prisma.projectMember.create({
          data: { projectId: project.id, userId: memberUser.id, joinedAt: todayDateOnly },
        });
      }
    }

    // Managers
    for (const mgrKey of p.managerKeys) {
      const mgrUser = usersByKey.get(mgrKey);
      if (!mgrUser) throw new Error(`fixture refs missing manager ${mgrKey}`);
      await prisma.projectManager.upsert({
        where: { projectId_managerId: { projectId: project.id, managerId: mgrUser.id } },
        create: { projectId: project.id, managerId: mgrUser.id },
        update: {},
      });
    }

    // Project-level billable rate (only meaningful for hourly projects, but
    // we seed all so the fixture is uniform).
    const rate = RBAC_TEST_FIXTURE.billableRatesByProjectKey[p.key] ?? 0;
    if (rate > 0) {
      const existingRate = await prisma.projectBillableRate.findFirst({
        where: { projectId: project.id, taskId: null, effectiveTo: null },
      });
      if (!existingRate) {
        await prisma.projectBillableRate.create({
          data: {
            projectId: project.id,
            taskId: null,
            rate: new Prisma.Decimal(rate),
            currency: p.currency,
            effectiveFrom: todayDateOnly,
            effectiveTo: null,
            createdBy: adminUser.id,
          },
        });
      }
    }
  }
  console.log(`[seed] projects ok (${projectsByKey.size})`);

  // ----- user_managers (person-anchor table) -----
  for (const [mgrKey, reportKeys] of Object.entries(RBAC_TEST_FIXTURE.personAnchors)) {
    const mgrUser = usersByKey.get(mgrKey);
    if (!mgrUser) continue;
    for (const reportKey of reportKeys) {
      const reportUser = usersByKey.get(reportKey);
      if (!reportUser) continue;
      await prisma.userManager.upsert({
        where: { userId_managerId: { userId: reportUser.id, managerId: mgrUser.id } },
        create: { userId: reportUser.id, managerId: mgrUser.id },
        update: {},
      });
    }
  }
  console.log('[seed] user_managers ok');

  // ----- Employee cost rates -----
  for (const [userKey, rate] of Object.entries(RBAC_TEST_FIXTURE.costRatesByUserKey)) {
    const u = usersByKey.get(userKey);
    if (!u) continue;
    const existing = await prisma.employeeCostRate.findFirst({
      where: { userId: u.id, effectiveTo: null },
    });
    if (!existing) {
      await prisma.employeeCostRate.create({
        data: {
          userId: u.id,
          rate: new Prisma.Decimal(rate),
          currency: RBAC_TEST_FIXTURE.currency,
          effectiveFrom: todayDateOnly,
          effectiveTo: null,
          createdBy: adminUser.id,
        },
      });
    }
  }
  console.log('[seed] employee_cost_rates ok');

  // ----- Sample time entries (prior week, draft state) -----
  // Two hours/day across two prior weekdays for bob+carol+dave so dashboards
  // aren't blank. We don't create entries for managers/admin to keep the
  // dataset minimal.
  const sampleUsers = ['bob', 'carol', 'dave'];
  const sampleProjects: Record<string, string> = {
    bob: 'P1',
    carol: 'P1',
    dave: 'P3',
  };

  // Build two 9am-11am local-day entries 7 and 8 days ago, in UTC.
  // We treat ZAR=UTC+2 for the offset since all sample users are in JNB tz.
  const sampleDaysAgo = [7, 8];
  for (const userKey of sampleUsers) {
    const u = usersByKey.get(userKey);
    const projKey = sampleProjects[userKey];
    const proj = projKey ? projectsByKey.get(projKey) : undefined;
    if (!u || !proj) continue;

    for (const daysAgo of sampleDaysAgo) {
      const startUtc = new Date(Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - daysAgo,
        7, 0, 0, 0, // 09:00 JNB (UTC+2) == 07:00 UTC
      ));
      const endUtc = new Date(startUtc.getTime() + 2 * 60 * 60 * 1000); // +2h

      // Idempotency: use a deterministic key so re-running seed is a no-op.
      const idempKey = `seed-${userKey}-${daysAgo}d`;
      const existing = await prisma.timeEntry.findFirst({
        where: { userId: u.id, idempotencyKey: idempKey },
      });
      if (!existing) {
        await prisma.timeEntry.create({
          data: {
            userId: u.id,
            projectId: proj.id,
            startAt: startUtc,
            endAt: endUtc,
            status: 'draft',
            billable: true,
            idempotencyKey: idempKey,
            notes: `Seed sample entry (${daysAgo}d ago)`,
          },
        });
      }
    }
  }
  console.log('[seed] sample time_entries ok');

  console.log('[seed] done');
}

main()
  .catch((err) => {
    console.error('[seed] FAILED');
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
