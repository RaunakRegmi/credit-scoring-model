/**
 * The global authentication gate.
 *
 * Registered application-wide in `AuthModule`, so every route is closed by default and opening
 * one is a visible `@Public()`. That ordering matters more than it looks: this dashboard shipped
 * unauthenticated, and the fix is not "add a guard to the routes we remember" but "make an
 * unguarded route the thing you have to write down".
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC_KEY, REQUIRED_ROLES_KEY } from './auth.decorators';
import { TokenService, type AuthenticatedStaff } from './token.service';

import type { StaffRole } from '@aics/contracts';

/** Routes reachable while a password change is outstanding. */
const ALLOWED_WHILE_PASSWORD_EXPIRED: readonly string[] = [
  '/api/auth/me',
  '/api/auth/change-password',
  '/api/auth/logout',
];

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const controller = context.getClass();

    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller]) === true;
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { staff?: AuthenticatedStaff }>();
    const staff = this.tokens.verifyAccessToken(bearerToken(request));

    // A provisioned account whose password has never been changed can do exactly two things:
    // change it, or sign out. Otherwise a seeded credential is a working credential.
    if (staff.mustChangePassword && !ALLOWED_WHILE_PASSWORD_EXPIRED.includes(request.path)) {
      throw new ForbiddenException(
        'This account must set a new password before it can be used. (PASSWORD_CHANGE_REQUIRED)',
      );
    }

    const requiredRoles = this.reflector.getAllAndOverride<readonly StaffRole[]>(
      REQUIRED_ROLES_KEY,
      [handler, controller],
    );

    if (requiredRoles !== undefined && requiredRoles.length > 0) {
      if (!requiredRoles.includes(staff.role)) {
        // Names the requirement, not the caller's role — an authorisation failure should not
        // double as an enumeration oracle for the permission model.
        throw new ForbiddenException(
          `This action requires one of the following roles: ${requiredRoles.join(', ')}.`,
        );
      }
    }

    request.staff = staff;
    return true;
  }
}

/**
 * Extracts the bearer token.
 *
 * Strict about the scheme. Accepting a bare token, or `Bearer` in any casing with any whitespace,
 * is the kind of leniency that makes it possible to smuggle a token past a proxy's inspection.
 */
function bearerToken(request: Request): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    throw new UnauthorizedException('Authentication required.');
  }

  const [scheme, token, ...rest] = header.split(' ');
  if (scheme !== 'Bearer' || token === undefined || token === '' || rest.length > 0) {
    throw new UnauthorizedException('Authentication required.');
  }

  return token;
}
