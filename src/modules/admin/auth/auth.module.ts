import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AdminJwtAuthGuard } from '../admin-jwt-auth.guard';
import { AdminJwtService } from './admin-jwt.service';
import { AdminRolesGuard } from '../../../shared/guards/admin-roles.guard';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [AdminJwtService, AdminJwtAuthGuard, AdminRolesGuard],
  exports: [AdminJwtService, AdminJwtAuthGuard, AdminRolesGuard],
})
export class AuthModule {}
