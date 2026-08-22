import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { CompanyService } from './company.service';

@AdminGuard('dev', 'owner')
@Controller('api/admin/company')
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get('brand-info')
  getBrandInfo() {
    return this.companyService.getBrandInfo();
  }

  @Post('add')
  @HttpCode(200)
  addCompany(@Req() request: FastifyRequest) {
    return this.companyService.addCompany(request);
  }
}
