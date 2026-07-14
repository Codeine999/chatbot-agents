import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRequest } from './admin-jwt-auth.guard';
import { AdminRole } from './admin-auth.types';

export const ADMIN_ROLES_KEY = 'adminRoles';

@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AdminRole[]>(
      ADMIN_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<AdminRequest>();

    if (!request.admin) {
      throw new UnauthorizedException('Admin authentication required');
    }

    if (!requiredRoles?.length || requiredRoles.includes(request.admin.role)) {
      return true;
    }

    throw new ForbiddenException('Insufficient admin role');
  }
}
