import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAuthModule } from './auth/admin-auth.module';

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
