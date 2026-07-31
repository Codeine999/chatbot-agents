import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminAnswerPatternService } from './admin-answer-pattern.service';
import {
  AdminAnswerPatternIdParamDto,
  CreateAdminAnswerPatternDto,
  UpdateAdminAnswerPatternDto,
} from './dto/admin-answer-pattern.dto';
import { Public } from 'src/shared/guards/public.decorator';

// @AdminGuard()

@Controller('/api/admin/answer-patterns')
export class AdminAnswerPatternController {
  constructor(
    private readonly answerPatternService: AdminAnswerPatternService,
  ) {}

  @Get()
  list() {
    return this.answerPatternService.list();
  }

  @AdminGuard('dev', 'owner')
  @Post('reindex')
  reindex() {
    return this.answerPatternService.reindex();
  }

  // @AdminGuard('dev', 'owner')
  @Public()
  @Post()
  create(@Body() body: CreateAdminAnswerPatternDto) {
    return this.answerPatternService.create(body);
  }

  @AdminGuard('dev', 'owner')
  @Patch(':id')
  update(
    @Param() params: AdminAnswerPatternIdParamDto,
    @Body() body: UpdateAdminAnswerPatternDto,
  ) {
    return this.answerPatternService.update(params.id, body);
  }

  @AdminGuard('dev', 'owner')
  @Delete(':id')
  remove(@Param() params: AdminAnswerPatternIdParamDto) {
    return this.answerPatternService.remove(params.id);
  }
}
