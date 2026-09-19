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
import { AdminKnowledgeMicroService } from './admin-knowledge-micro.service';
import {
  AdminMicroKnowledgeIdParamDto,
  CreateAdminMicroKnowledgeDto,
  UpdateAdminMicroKnowledgeDto,
} from './dto/admin-micro-knowledge.dto';

@AdminGuard()
@Controller('/api/admin/knowledge-micro')
export class AdminKnowledgeMicroController {
  constructor(
    private readonly knowledgeMicroService: AdminKnowledgeMicroService,
  ) {}

  @Get()
  list() {
    return this.knowledgeMicroService.list();
  }

  @Get('count')
  count() {
    return this.knowledgeMicroService.count();
  }

  @AdminGuard('dev', 'owner')
  @Post('reindex')
  reindex(@Req() request: AdminRequest) {
    return this.knowledgeMicroService.reindex(request.admin?.id);
  }

  @AdminGuard('dev', 'owner')
  @Post()
  create(
    @Req() request: AdminRequest,
    @Body() body: CreateAdminMicroKnowledgeDto,
  ) {
    return this.knowledgeMicroService.create(body, request.admin?.id);
  }

  @AdminGuard('dev', 'owner')
  @Patch(':id')
  update(
    @Req() request: AdminRequest,
    @Param() params: AdminMicroKnowledgeIdParamDto,
    @Body() body: UpdateAdminMicroKnowledgeDto,
  ) {
    return this.knowledgeMicroService.update(
      params.id,
      body,
      request.admin?.id,
    );
  }

  @AdminGuard('dev', 'owner')
  @Delete(':id')
  remove(@Param() params: AdminMicroKnowledgeIdParamDto) {
    return this.knowledgeMicroService.remove(params.id);
  }
}
