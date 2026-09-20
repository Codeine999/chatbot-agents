import { UnauthorizedException } from '@nestjs/common';
import type { AdminRequest } from '../admin-jwt-auth.guard';

/**
 * Rich menu APIs currently use only null scope. Authentication is still
 * required; existing non-null rows are not merged into this scope.
 */
export function tenantOf(request: AdminRequest): string | null {
  if (!request.admin) {
    throw new UnauthorizedException('Admin authentication required');
  }

  // Single-company deployment. Keep the column reserved for future tenancy.
  return null;
}
