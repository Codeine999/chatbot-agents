import { Controller } from '@nestjs/common';
import { AdminGuard } from '../../shared/guards/admin-guard.decorator';

@AdminGuard()
@Controller('admin')
export class AdminController {}
