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
import { AdminAnswerPatternService } from './admin-answer-pattern.service';
import {
  AdminAnswerPatternIdParamDto,
  CreateAdminAnswerPatternDto,
  UpdateAdminAnswerPatternDto,
} from './dto/admin-answer-pattern.dto';
@AdminGuard()
@Controller('/api/admin/answer-patterns')
export class AdminAnswerPatternController {
  constructor(
    private readonly answerPatternService: AdminAnswerPatternService,
  ) {}

  @Get()
  list() {
    return this.answerPatternService.list();
  }

  @Get('count')
  count() {
    return this.answerPatternService.count();
  }

  @AdminGuard('dev', 'owner')
  @Post('reindex')
  reindex(@Req() request: AdminRequest) {
    return this.answerPatternService.reindex(request.admin?.id);
  }

  @AdminGuard('dev', 'owner')
  @Post()
  create(
    @Req() request: AdminRequest,
    @Body() body: CreateAdminAnswerPatternDto,
  ) {
    return this.answerPatternService.create(body, request.admin?.id);
  }

  @AdminGuard('dev', 'owner')
  @Patch(':id')
  update(
    @Req() request: AdminRequest,
    @Param() params: AdminAnswerPatternIdParamDto,
    @Body() body: UpdateAdminAnswerPatternDto,
  ) {
    return this.answerPatternService.update(params.id, body, request.admin?.id);
  }

  @AdminGuard('dev', 'owner')
  @Delete(':id')
  remove(@Param() params: AdminAnswerPatternIdParamDto) {
    return this.answerPatternService.remove(params.id);
  }
}
