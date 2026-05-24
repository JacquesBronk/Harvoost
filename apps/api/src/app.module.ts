import { Module } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RbacModule } from './rbac/rbac.module';
import { CommonModule } from './common/common.module';
import { AuditModule } from './common/audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BearerAuthGuard } from './auth/bearer-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { ClientsModule } from './clients/clients.module';
import { ProjectsModule } from './projects/projects.module';
import { TimeEntriesModule } from './time-entries/time-entries.module';
import { MoodModule } from './mood/mood.module';
import { SchedulesModule } from './schedules/schedules.module';
import { LeaveModule } from './leave/leave.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { ExceptionsModule } from './exceptions/exceptions.module';
import { ReportsModule } from './reports/reports.module';
import { CostRatesModule } from './cost-rates/cost-rates.module';
import { BillableRatesModule } from './billable-rates/billable-rates.module';
import { ExportsModule } from './exports/exports.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { ChatbotModule } from './chatbot/chatbot.module';
import { LlmModule } from './chatbot/llm.module';
import { SyncModule } from './sync/sync.module';
import { PrincipalThrottlerGuard } from './common/throttler/principal-throttler.guard';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RbacModule,
    CommonModule,
    AuditModule,
    LlmModule,
    // INC-005 (issue #8): rate-limit buckets. IMPORTANT — in @nestjs/throttler
    // v6.5.0 EVERY bucket declared here is enforced on EVERY route (the guard
    // loops `this.throttlers` per request and 429s on the first that blocks),
    // unless a route opts out. The previous config let the smallest bucket
    // (`auth` 5/60s) cap all routes, so normal navigation tripped 429.
    //   - `global`  : the ONLY app-wide bucket. Per authenticated principal
    //                 (see PrincipalThrottlerGuard.getTracker), 1000/60s — well
    //                 above realistic single-user page fan-out, still bounds abuse.
    //   - `auth`    : 5/60s brute-force cap. OPT-IN ONLY — PrincipalThrottlerGuard
    //                 exempts any route that does not carry @Throttle({auth}).
    //                 Applied via the class-level @Throttle on AuthController
    //                 (login/callback); /me is @SkipThrottle({auth:true}).
    //   - `chatbot` : 30/60s. OPT-IN ONLY — applied via @Throttle({chatbot}) on
    //                 ChatbotController.postMessage.
    // Storage is the in-memory default (single-process); a Redis-backed store is
    // a documented v1.1 follow-up before horizontal scaling.
    ThrottlerModule.forRoot([
      { name: 'chatbot', ttl: 60_000, limit: 30 },
      { name: 'auth', ttl: 60_000, limit: 5 },
      { name: 'global', ttl: 60_000, limit: 1000 },
    ]),
    AuthModule,
    HealthModule,
    UsersModule,
    ClientsModule,
    ProjectsModule,
    TimeEntriesModule,
    MoodModule,
    SchedulesModule,
    LeaveModule,
    ApprovalsModule,
    ExceptionsModule,
    ReportsModule,
    CostRatesModule,
    BillableRatesModule,
    ExportsModule,
    AuditLogModule,
    ChatbotModule,
    SyncModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // Guard ORDER matters: BearerAuthGuard runs first so `req.user` is populated
    // before PrincipalThrottlerGuard.getTracker reads it (per-principal keying).
    { provide: APP_GUARD, useClass: BearerAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PrincipalThrottlerGuard },
  ],
})
export class AppModule {}
