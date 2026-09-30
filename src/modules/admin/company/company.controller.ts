import { Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { MultipartUploadService } from '../../../shared/upload/multipart-upload.service';
import { CompanyService } from './company.service';
import { COMPANY_IMAGE_MAX_BYTES } from './company-upload.constants';
import { UpdateCompanyDto } from './dto/update-company.dto';

@AdminGuard('dev', 'owner')
@Controller('api/admin/company')
export class CompanyController {
  constructor(
    private readonly companyService: CompanyService,
    private readonly multipartUploadService: MultipartUploadService,
  ) {}

  @Get('brand-info')
  getBrandInfo() {
    return this.companyService.getBrandInfo();
  }

  @Post('add')
  @HttpCode(200)
  addCompany(@Req() request: FastifyRequest) {
    return this.companyService.addCompany(request);
  }

  /** Multipart: `name` and/or `image`; whatever is left out stays as it is. */
  @Patch()
  async updateCompany(@Req() request: FastifyRequest) {
    const dto = await this.multipartUploadService.parseDto(
      request,
      UpdateCompanyDto.schema,
      {
        maxFileSize: COMPANY_IMAGE_MAX_BYTES,
        maxFiles: 1,
        maxFields: 2,
        notMultipartMessage: 'Send a name, an image, or both as multipart',
        invalidMultipartMessage: 'Invalid multipart company data',
      },
    );

    return this.companyService.updateCompany(dto);
  }
}
