import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthenticatedAdmin } from './admin-auth.types';
import { AdminJwtService } from '../../modules/admin/auth/admin-jwt.service';

export type AdminRequest = FastifyRequest & {
  admin?: AuthenticatedAdmin;
};

@Injectable()
export class AdminJwtAuthGuard implements CanActivate {
  constructor(private readonly adminJwtService: AdminJwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Admin authentication required');
    }

    const admin = await this.adminJwtService.authenticate(token);

    if (!admin) {
      throw new UnauthorizedException('Invalid or expired admin token');
    }

    request.admin = admin;
    return true;
  }

  private extractBearerToken(request: FastifyRequest): string | undefined {
    const authorization = request.headers.authorization;

    if (typeof authorization !== 'string') return undefined;

    const [scheme, token, extra] = authorization.trim().split(/\s+/);
    if (scheme !== 'Bearer' || !token || extra) return undefined;

    return token;
  }
}
