import { Controller } from '@nestjs/common';
import { AdminGuard } from '../../infra/auth/admin-guard.decorator';

@AdminGuard()
@Controller('admin')
export class AdminController {}
