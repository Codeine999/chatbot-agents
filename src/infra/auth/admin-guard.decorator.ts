import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AdminRole } from './admin-auth.types';
import { AdminJwtAuthGuard } from './admin-jwt-auth.guard';
import { ADMIN_ROLES_KEY, AdminRolesGuard } from './admin-roles.guard';

export function AdminGuard(...roles: AdminRole[]) {
  return applyDecorators(
    SetMetadata(ADMIN_ROLES_KEY, roles),
    UseGuards(AdminJwtAuthGuard, AdminRolesGuard),
    ApiBearerAuth(),
  );
}
