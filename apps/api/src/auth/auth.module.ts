import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { BearerAuthGuard } from './bearer-auth.guard';
import { RolesGuard } from './roles.guard';
import { OidcService } from './oidc.service';

@Module({
  controllers: [AuthController],
  providers: [BearerAuthGuard, RolesGuard, OidcService],
  exports: [BearerAuthGuard, RolesGuard, OidcService],
})
export class AuthModule {}
