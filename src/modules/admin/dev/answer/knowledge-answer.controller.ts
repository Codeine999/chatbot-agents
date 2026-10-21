import { Body, Controller, Param, Patch, Post, Req } from '@nestjs/common';
import type { AdminRequest } from '../../admin-jwt-auth.guard';
import { AdminGuard } from '../../../../shared/guards/admin-guard.decorator';
import {
  AdminAnswerPatternIdParamDto,
  UpdateAdminAnswerPatternDto,
} from '../../knowledge/dto/admin-answer-pattern.dto';
import {
  AdminMicroKnowledgeIdParamDto,
  UpdateAdminMicroKnowledgeDto,
} from '../../knowledge/dto/admin-micro-knowledge.dto';
import {
  BulkCreateAnswerPatternDto,
  BulkCreateMicroKnowledgeDto,
} from './dto/knowledge-answer.dto';
import { KnowledgeAnswerService } from './knowledge-answer.service';

@AdminGuard('dev')
@Controller('/api/dev/knowledge')
export class KnowledgeAnswerController {
  constructor(private readonly knowledgeAnswer: KnowledgeAnswerService) {}

  @Post('answer-patterns')
  createPatterns(
    @Req() request: AdminRequest,
    @Body() body: BulkCreateAnswerPatternDto,
  ) {
    return this.knowledgeAnswer.createPatterns(body, request.admin?.id);
  }

  @Patch('answer-patterns/:id')
  updatePattern(
    @Req() request: AdminRequest,
    @Param() params: AdminAnswerPatternIdParamDto,
    @Body() body: UpdateAdminAnswerPatternDto,
  ) {
    return this.knowledgeAnswer.updatePattern(
      params.id,
      body,
      request.admin?.id,
    );
  }

  @Post('micro')
  createMicro(
    @Req() request: AdminRequest,
    @Body() body: BulkCreateMicroKnowledgeDto,
  ) {
    return this.knowledgeAnswer.createMicro(body, request.admin?.id);
  }

  @Patch('micro/:id')
  updateMicro(
    @Req() request: AdminRequest,
    @Param() params: AdminMicroKnowledgeIdParamDto,
    @Body() body: UpdateAdminMicroKnowledgeDto,
  ) {
    return this.knowledgeAnswer.updateMicro(params.id, body, request.admin?.id);
  }
}
