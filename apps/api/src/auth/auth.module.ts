import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { APP_CONFIG, type AppConfig } from '../config/configuration';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginThrottle } from './login-throttle';
import { StaffAdminController } from './staff-admin.controller';
import { StaffAdminService } from './staff-admin.service';
import { TokenService } from './token.service';

/**
 * Authentication and authorisation.
 *
 * `APP_GUARD` registers `JwtAuthGuard` for every route in the application, including routes in
 * modules that know nothing about this one. That is the intended reading: a new controller is
 * protected the moment it is written, and exposing it takes a deliberate `@Public()`.
 *
 * `@Global()` so `AuthService` is injectable where a second authoriser has to be verified
 * (the underwriter module) without that module importing an authentication dependency it would
 * then be free to forget.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.auth.jwtSecret,
        signOptions: {
          // Pinned rather than defaulted. `alg: none` and algorithm-confusion attacks both begin
          // with a verifier that accepts whatever the token claims.
          algorithm: 'HS256',
          expiresIn: config.auth.accessTokenTtlSeconds,
          issuer: 'aics-api',
          audience: 'aics-dashboard',
        },
        verifyOptions: {
          algorithms: ['HS256'],
          issuer: 'aics-api',
          audience: 'aics-dashboard',
        },
      }),
    }),
  ],
  controllers: [AuthController, StaffAdminController],
  providers: [
    AuthService,
    TokenService,
    StaffAdminService,
    LoginThrottle,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
