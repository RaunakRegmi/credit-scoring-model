/**
 * Authentication endpoints.
 *
 * Validation uses the zod schemas from `@aics/contracts`, matching the rest of the API — the
 * login form and this controller are checked against one definition.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  type LoginResult,
  type StaffIdentity,
} from '@aics/contracts';
import type { z } from 'zod';

import { AuthService, type RequestContext } from './auth.service';
import { CurrentStaff, Public } from './auth.decorators';
import { LoginThrottle } from './login-throttle';
import type { AuthenticatedStaff } from './token.service';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly throttle: LoginThrottle,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() request: Request): Promise<LoginResult> {
    const parsed = parseOrThrow(loginSchema, body, 'Invalid login payload');
    const context = requestContext(request);

    // Keyed on source address and target email together, so one shared office address cannot
    // lock out everyone behind it, and one email cannot be ground from a rotating address pool.
    const key = `${context.ipAddress ?? 'unknown'}|${parsed.email.trim().toLowerCase()}`;
    const verdict = this.throttle.check(key);

    if (!verdict.allowed) {
      throw new HttpException(
        {
          message: `Too many sign-in attempts. Try again in ${Math.ceil(
            verdict.retryAfterSeconds / 60,
          )} minute(s).`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const result = await this.auth.login(parsed, context);
    this.throttle.reset(key);
    return result;
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown, @Req() request: Request): Promise<LoginResult> {
    const parsed = parseOrThrow(refreshSchema, body, 'Invalid refresh payload');
    return this.auth.refresh(parsed.refreshToken, requestContext(request));
  }

  /**
   * Sign out. Public because a client whose access token has already expired must still be able
   * to invalidate its refresh session — the token in the body is the credential being spent.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown): Promise<void> {
    const parsed = refreshSchema.safeParse(body);
    if (parsed.success) {
      await this.auth.logout(parsed.data.refreshToken);
    }
    // A malformed logout is not an error worth surfacing: the caller's intent was to end the
    // session, and it either does not exist or was never valid.
  }

  @Get('me')
  async me(@CurrentStaff() staff: AuthenticatedStaff): Promise<StaffIdentity> {
    return this.auth.currentStaff(staff.id);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentStaff() staff: AuthenticatedStaff,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = parseOrThrow(changePasswordSchema, body, 'Invalid password change payload');
    await this.auth.changePassword(staff.id, parsed);
  }
}

function requestContext(request: Request): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
    ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
  };
}

function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  message: string,
): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      message,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
