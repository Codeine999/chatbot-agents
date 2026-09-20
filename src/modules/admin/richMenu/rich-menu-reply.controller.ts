import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { RichMenuReplyService } from './rich-menu-reply.service';
import {
  CreateRichMenuReplyDto,
  ListRichMenuReplyQueryDto,
  RichMenuReplyIdParamDto,
  UpdateRichMenuReplyDto,
} from './dto/rich-menu-reply.dto';
import { tenantOf } from './rich-menu-tenant';

/**
 * What the bot answers for each rich menu button, owned by the caller's
 * company. Reading is open to any admin; writing is `dev`/`owner` like the
 * rest of the back office.
 */
@AdminGuard()
@Controller('api/admin/rich-menu-replies')
export class RichMenuReplyController {
  constructor(private readonly replyService: RichMenuReplyService) {}

  @Get()
  list(
    @Req() request: AdminRequest,
    @Query() query: ListRichMenuReplyQueryDto,
  ) {
    return this.replyService.list(tenantOf(request), query);
  }

  @Get(':id')
  get(@Req() request: AdminRequest, @Param() params: RichMenuReplyIdParamDto) {
    return this.replyService.get(tenantOf(request), params.id);
  }

  @AdminGuard('dev', 'owner')
  @Post()
  create(@Req() request: AdminRequest, @Body() body: CreateRichMenuReplyDto) {
    return this.replyService.create(
      tenantOf(request),
      body,
      request.admin?.id,
    );
  }

  @AdminGuard('dev', 'owner')
  @Patch(':id')
  update(
    @Req() request: AdminRequest,
    @Param() params: RichMenuReplyIdParamDto,
    @Body() body: UpdateRichMenuReplyDto,
  ) {
    return this.replyService.update(tenantOf(request), params.id, body);
  }

  @AdminGuard('dev', 'owner')
  @Delete(':id')
  remove(
    @Req() request: AdminRequest,
    @Param() params: RichMenuReplyIdParamDto,
  ) {
    return this.replyService.remove(tenantOf(request), params.id);
  }
}
