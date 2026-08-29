import { Module } from '@nestjs/common';
import { MultipartUploadService } from './multipart-upload.service';

@Module({
  providers: [MultipartUploadService],
  exports: [MultipartUploadService],
})
export class MultipartUploadModule {}
