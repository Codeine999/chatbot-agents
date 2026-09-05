import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AdminRequest } from '../../admin/admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import {
  EmbeddingBackfillDto,
  EmbeddingCoverageQueryDto,
  EmbeddingPreviewDto,
  EmbeddingSearchDto,
  EmbeddingUsageQueryDto,
} from './dto/embedding.dto';
import { EmbeddingAdminService } from './embedding-admin.service';

/**
 * Back-office surface for the Gemini embedding index.
 *
 * Reads are open to any admin; anything that calls the provider costs credit
 * and is limited to dev/owner. The knowledge base itself is edited through
 * the answer-pattern routes — these operate on the vectors derived from it.
 */
@Controller('api/admin/embedding')
export class EmbeddingController {
  constructor(private readonly embeddingAdminService: EmbeddingAdminService) {}

  /** Provider, model, dimensions and the active price the wallet is charged. */
  @AdminGuard()
  @Get('config')
  getConfig() {
    return this.embeddingAdminService.getConfig();
  }

  /** Which active patterns vector search can reach, and which it cannot. */
  @AdminGuard()
  @Get('coverage')
  getCoverage(@Query() query: EmbeddingCoverageQueryDto) {
    return this.embeddingAdminService.getCoverage(query.status);
  }

  /** Recent `UsageKind.EMBEDDING` spend and failures. */
  @AdminGuard()
  @Get('usage')
  getUsage(@Query() query: EmbeddingUsageQueryDto) {
    return this.embeddingAdminService.getUsage(query);
  }

  @AdminGuard('dev', 'owner')
  @Post('backfill')
  @HttpCode(200)
  backfill(@Req() request: AdminRequest, @Body() body: EmbeddingBackfillDto) {
    return this.embeddingAdminService.backfill(body, request.admin?.id);
  }

  /** Embeds arbitrary text and reports the vector's shape, not the vector. */
  @AdminGuard('dev', 'owner')
  @Post('preview')
  @HttpCode(200)
  preview(@Req() request: AdminRequest, @Body() body: EmbeddingPreviewDto) {
    return this.embeddingAdminService.preview(body, request.admin?.id);
  }

  /** Runs the chatbot's own pgvector search for one query, with scores. */
  @AdminGuard('dev', 'owner')
  @Post('search')
  @HttpCode(200)
  search(@Req() request: AdminRequest, @Body() body: EmbeddingSearchDto) {
    return this.embeddingAdminService.search(body, request.admin?.id);
  }
}
