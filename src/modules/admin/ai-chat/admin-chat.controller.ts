import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminChatService } from './admin-chat.service';
import { AdminAiUsageService } from './admin-ai-usage.service';
import {
  AdminMemberIdParamDto,
  CreateAdminChatRoomDto,
  RenameAdminChatRoomDto,
  RoomIdParamDto,
  SendAdminChatMessageDto,
  SetAdminAiBudgetDto,
} from './dto/admin-chat.dto';

/**
 * Back-office AI chat. Every route derives the admin id from the JWT, never
 * from the request body, so an admin can only ever reach their own rooms.
 */
@AdminGuard()
@Controller('api/admin/ai-chat')
export class AdminChatController {
  constructor(
    private readonly adminChatService: AdminChatService,
    private readonly usageService: AdminAiUsageService,
  ) {}

  @Get('rooms')
  listRooms(@Req() request: AdminRequest) {
    return this.adminChatService.listRooms(this.adminId(request));
  }

  @Post('rooms')
  createRoom(
    @Req() request: AdminRequest,
    @Body() body: CreateAdminChatRoomDto,
  ) {
    return this.adminChatService.createRoom(this.adminId(request), body.title);
  }

  @Patch('rooms/:roomId')
  renameRoom(
    @Req() request: AdminRequest,
    @Param() params: RoomIdParamDto,
    @Body() body: RenameAdminChatRoomDto,
  ) {
    return this.adminChatService.renameRoom(
      this.adminId(request),
      params.roomId,
      body.title,
    );
  }

  @Delete('rooms/:roomId')
  @HttpCode(200)
  async deleteRoom(
    @Req() request: AdminRequest,
    @Param() params: RoomIdParamDto,
  ) {
    await this.adminChatService.deleteRoom(
      this.adminId(request),
      params.roomId,
    );
    return { success: true };
  }

  @Get('rooms/:roomId/messages')
  listMessages(@Req() request: AdminRequest, @Param() params: RoomIdParamDto) {
    return this.adminChatService.listMessages(
      this.adminId(request),
      params.roomId,
    );
  }

  @Post('messages')
  @HttpCode(200)
  sendMessage(
    @Req() request: AdminRequest,
    @Body() body: SendAdminChatMessageDto,
  ) {
    return this.adminChatService.sendMessage(this.adminId(request), body);
  }

  @Get('usage/me')
  getMyUsage(@Req() request: AdminRequest) {
    return this.usageService.getMyUsage(this.adminId(request));
  }

  /** Owner/dev report: usage for every admin, joined with id + username. */
  @AdminGuard('dev', 'owner')
  @Get('usage')
  listAllUsage() {
    return this.usageService.listAllUsage();
  }

  /** Owner/dev: set one admin's AI budget (`null` = unlimited). */
  @AdminGuard('dev', 'owner')
  @Patch('usage/:adminMemberId/budget')
  setBudget(
    @Param() params: AdminMemberIdParamDto,
    @Body() body: SetAdminAiBudgetDto,
  ) {
    return this.usageService.setLimit(
      params.adminMemberId,
      body.limitCredit === null ? null : String(body.limitCredit),
    );
  }

  private adminId(request: AdminRequest): string {
    if (!request.admin) {
      throw new Error('AdminGuard must run before accessing admin chat');
    }

    return request.admin.id;
  }
}
