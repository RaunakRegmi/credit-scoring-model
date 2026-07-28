/**
 * Staff account administration endpoints.
 *
 * Listing is open to compliance as well as administrators — "who had access, and what could they
 * approve" is an audit question. Everything that changes an account is administrators only.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CAN_MANAGE_STAFF,
  CAN_VIEW_AUDIT,
  createStaffSchema,
  resetStaffPasswordSchema,
  updateStaffSchema,
  type StaffSummary,
} from '@aics/contracts';
import type { z } from 'zod';

import { CurrentStaff, Roles } from './auth.decorators';
import { StaffAdminService } from './staff-admin.service';
import type { AuthenticatedStaff } from './token.service';

@Controller('api/staff')
export class StaffAdminController {
  constructor(private readonly staff: StaffAdminService) {}

  @Roles(...CAN_MANAGE_STAFF, ...CAN_VIEW_AUDIT)
  @Get()
  async list(): Promise<readonly StaffSummary[]> {
    return this.staff.list();
  }

  @Roles(...CAN_MANAGE_STAFF)
  @Post()
  async create(
    @CurrentStaff() actor: AuthenticatedStaff,
    @Body() body: unknown,
  ): Promise<StaffSummary> {
    const parsed = parseOrThrow(createStaffSchema, body, 'Invalid staff account payload');
    return this.staff.create(parsed, actor.email);
  }

  @Roles(...CAN_MANAGE_STAFF)
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) staffId: string,
    @CurrentStaff() actor: AuthenticatedStaff,
    @Body() body: unknown,
  ): Promise<StaffSummary> {
    const parsed = parseOrThrow(updateStaffSchema, body, 'Invalid staff update payload');
    return this.staff.update(staffId, parsed, { id: actor.id, email: actor.email });
  }

  @Roles(...CAN_MANAGE_STAFF)
  @Post(':id/reset-password')
  @HttpCode(204)
  async resetPassword(
    @Param('id', ParseUUIDPipe) staffId: string,
    @CurrentStaff() actor: AuthenticatedStaff,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = parseOrThrow(resetStaffPasswordSchema, body, 'Invalid password reset payload');
    await this.staff.resetPassword(staffId, parsed, actor.email);
  }
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
