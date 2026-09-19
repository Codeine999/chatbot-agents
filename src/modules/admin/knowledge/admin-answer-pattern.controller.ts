import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminKnowledgePatternService } from './admin-knowledge-pattern.service';
import {
  AdminAnswerPatternIdParamDto,
  CreateAdminAnswerPatternDto,
  UpdateAdminAnswerPatternDto,
} from './dto/admin-answer-pattern.dto';
@AdminGuard()
@Controller('/api/admin/knowledge-patterns')
export class AdminKnowledgePatternController {
  constructor(
    private readonly knowledgePatternService: AdminKnowledgePatternService,
  ) {}

  @Get()
  list() {
    return this.knowledgePatternService.list();
  }

  @Get('count')
  count() {
    return this.knowledgePatternService.count();
  }

  @AdminGuard('dev', 'owner')
  @Post('reindex')
  reindex(@Req() request: AdminRequest) {
    return this.knowledgePatternService.reindex(request.admin?.id);
  }

  @AdminGuard('dev', 'owner')
  @Post()
  create(
    @Req() request: AdminRequest,
    @Body() body: CreateAdminAnswerPatternDto,
  ) {
    return this.knowledgePatternService.create(body, request.admin?.id);
  }

  @AdminGuard('dev', 'owner')
  @Patch(':id')
  update(
    @Req() request: AdminRequest,
    @Param() params: AdminAnswerPatternIdParamDto,
    @Body() body: UpdateAdminAnswerPatternDto,
  ) {
    return this.knowledgePatternService.update(
      params.id,
      body,
      request.admin?.id,
    );
  }

  @AdminGuard('dev', 'owner')
  @Delete(':id')
  remove(@Param() params: AdminAnswerPatternIdParamDto) {
    return this.knowledgePatternService.remove(params.id);
  }
}

// Transitional export while callers move to the knowledge-oriented name.
export { AdminKnowledgePatternController as AdminAnswerPatternController };
