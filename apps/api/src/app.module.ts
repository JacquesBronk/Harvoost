import { Module } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RbacModule,
    CommonModule,
    AuditModule,
    LlmModule,
    ThrottlerModule.forRoot([
      { name: 'chatbot', ttl: 60_000, limit: 30 },
      { name: 'auth', ttl: 60_000, limit: 5 },
      { name: 'global', ttl: 60_000, limit: 300 },
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
    { provide: APP_GUARD, useClass: BearerAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
