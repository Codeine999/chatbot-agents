import { Module } from '@nestjs/common';
import { StorageModule } from '../../../infra/storage/storage.module';
import { MultipartUploadModule } from '../../../shared/upload/multipart-upload.module';
import { CompanyModule } from '../company/company.module';
import { AdminBillController } from './admin-bill.controller';
import { AdminBillService } from './admin-bill.service';

@Module({
  imports: [CompanyModule, MultipartUploadModule, StorageModule],
  controllers: [AdminBillController],
  providers: [AdminBillService],
})
export class AdminBillModule {}
