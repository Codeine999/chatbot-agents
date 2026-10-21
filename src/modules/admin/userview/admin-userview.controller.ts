import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminUserViewService } from './admin-userview.service';
import {
  PreviewSessionIdParamDto,
  SendPreviewMessageDto,
} from './dto/admin-userview.dto';

/**
 * Customer-view chat preview. Turns are answered by the production chatbot and
 * charged to the company wallet like LINE traffic, but never reach LINE.
 * Sessions are keyed by the admin id from the JWT, so an admin can only reach
 * their own previews.
 */
@AdminGuard()
@Controller('api/admin/userview')
export class AdminUserViewController {
  constructor(private readonly userViewService: AdminUserViewService) {}

  @Post('sessions')
  createSession(@Req() request: AdminRequest) {
    return this.userViewService.createSession(this.adminId(request));
  }

  @Get('sessions/:sessionId')
  getSession(
    @Req() request: AdminRequest,
    @Param() params: PreviewSessionIdParamDto,
  ) {
    return this.userViewService.getSession(
      this.adminId(request),
      params.sessionId,
    );
  }

  @Post('sessions/:sessionId/messages')
  @HttpCode(200)
  sendMessage(
    @Req() request: AdminRequest,
    @Param() params: PreviewSessionIdParamDto,
    @Body() body: SendPreviewMessageDto,
  ) {
    return this.userViewService.sendMessage(
      this.adminId(request),
      params.sessionId,
      body,
    );
  }

  @Delete('sessions/:sessionId')
  @HttpCode(200)
  async deleteSession(
    @Req() request: AdminRequest,
    @Param() params: PreviewSessionIdParamDto,
  ) {
    await this.userViewService.deleteSession(
      this.adminId(request),
      params.sessionId,
    );
    return { success: true };
  }

  private adminId(request: AdminRequest): string {
    if (!request.admin) {
      throw new Error('AdminGuard must run before accessing user view');
    }

    return request.admin.id;
  }
}
