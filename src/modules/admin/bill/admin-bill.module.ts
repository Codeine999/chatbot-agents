import { Module } from '@nestjs/common';
import { MultipartUploadModule } from '../../../shared/upload/multipart-upload.module';
import { CompanyModule } from '../company/company.module';
import { AdminBillController } from './admin-bill.controller';
import { AdminBillService } from './admin-bill.service';

@Module({
  imports: [CompanyModule, MultipartUploadModule],
  controllers: [AdminBillController],
  providers: [AdminBillService],
})
export class AdminBillModule {}
