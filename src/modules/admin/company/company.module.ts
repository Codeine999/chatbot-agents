import { Module } from '@nestjs/common';
import { StorageModule } from '../../../infra/storage/storage.module';
import { MultipartUploadModule } from '../../../shared/upload/multipart-upload.module';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';

@Module({
  imports: [StorageModule, MultipartUploadModule],
  controllers: [CompanyController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
