import { Controller, Get, Query, Req } from '@nestjs/common';
import type { AdminRequest } from '../../admin/admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { EmbeddingHealthQueryDto } from './dto/embedding.dto';
import { EmbeddingHealthService } from './embedding-health.service';

/**
 * Sits on its own `health` prefix rather than under the embedding routes so
 * a uptime monitor has one stable path to poll, independent of whatever the
 * back office adds to the admin surface later.
 */
@Controller('api/admin/health')
export class EmbeddingHealthController {
  constructor(private readonly healthService: EmbeddingHealthService) {}

  @AdminGuard()
  @Get('embedding')
  checkEmbedding(
    @Req() request: AdminRequest,
    @Query() query: EmbeddingHealthQueryDto,
  ) {
    return this.healthService.check({
      deep: query.deep,
      query: query.query,
      adminMemberId: request.admin?.id,
    });
  }
}
