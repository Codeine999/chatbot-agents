import { Controller, Get } from '@nestjs/common';
import { AdminGuard } from '../../shared/guards/admin-guard.decorator';
import { CompanyService } from '../admin/company/company.service';
import { LineService } from './line-reply.service';
import { LineAdminService } from './admin/line-admin.service';

@AdminGuard()
@Controller('api/line/dashboard')
export class LineDashboardController {
  constructor(
    private readonly lineService: LineService,
    private readonly companyService: CompanyService,
    private readonly lineAdminService: LineAdminService
  ) {}


}
