/**
 * Access-control decorators.
 *
 * The guard is registered globally, so the default for every route in this application is
 * "authentication required". `@Public()` is the explicit, greppable opt-out — the inverse
 * arrangement, where a route is open unless someone remembers to guard it, is how an
 * unauthenticated endpoint reaches production.
 */
import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { StaffRole } from '@aics/contracts';

import type { AuthenticatedStaff } from './token.service';

export const IS_PUBLIC_KEY = 'aics:isPublic';
export const REQUIRED_ROLES_KEY = 'aics:requiredRoles';

/** Marks a route as reachable without a token. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Restricts a route to the listed roles.
 *
 * Membership, not seniority: a route open to `CREDIT_MANAGER` is not implicitly open to `ADMIN`.
 * Rank comparisons exist (`hasAuthority`) but are used for the SOP-004 authority check, where the
 * question genuinely is "is this person senior enough". For route access, listing the roles keeps
 * the permission auditable by reading the decorator.
 */
export const Roles = (...roles: readonly StaffRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLES_KEY, roles);

interface RequestWithStaff {
  readonly staff?: AuthenticatedStaff;
}

/**
 * Injects the authenticated principal.
 *
 * Throws rather than returning `undefined` when absent. Reaching this on an unauthenticated
 * request means the global guard was bypassed, and a handler that quietly received `undefined`
 * would go on to write an audit row with no actor.
 */
export const CurrentStaff = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedStaff => {
    const request = context.switchToHttp().getRequest<RequestWithStaff>();
    if (request.staff === undefined) {
      throw new Error(
        'CurrentStaff used on a route with no authenticated principal. Remove @Public() or ' +
          'stop reading the principal here.',
      );
    }
    return request.staff;
  },
);
