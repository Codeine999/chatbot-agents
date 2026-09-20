import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiConsumes } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { RichMenuService } from './rich-menu.service';
import { tenantOf } from './rich-menu-tenant';
import {
  ApplyRichMenuLayoutDto,
  CreateRichMenuTemplateDto,
  LineUserIdParamDto,
  RichMenuCellParamDto,
  LinkRichMenuUsersDto,
  ListRichMenuTemplateQueryDto,
  PublishRichMenuTemplateDto,
  RichMenuStatsQueryDto,
  RichMenuTemplateIdParamDto,
  UpdateRichMenuTemplateDto,
} from './dto/rich-menu.dto';

/**
 * Rich menu back office.
 *
 * Reading is open to any admin; anything that changes what LINE users see is
 * restricted to `dev` and `owner`, matching the other admin write endpoints.
 *
 * Routes with a static first segment (`line`, `users`, `default`, `unlink`)
 * are declared before the `:id` routes so the file reads in match order.
 */
@AdminGuard()
@Controller('api/admin/rich-menus')
export class RichMenuController {
  constructor(private readonly richMenuService: RichMenuService) {}

  @Get()
  list(
    @Req() request: AdminRequest,
    @Query() query: ListRichMenuTemplateQueryDto,
  ) {
    return this.richMenuService.list(tenantOf(request), query);
  }

  /** Everything that currently exists on the LINE channel itself. */
  @Get('line')
  listOnLine(@Req() request: AdminRequest) {
    return this.richMenuService.listOnLine(tenantOf(request));
  }

  /** Which menu one user is seeing right now. */
  @Get('users/:lineUserId')
  getUserMenu(
    @Req() request: AdminRequest,
    @Param() params: LineUserIdParamDto,
  ) {
    return this.richMenuService.getUserMenu(
      tenantOf(request),
      params.lineUserId,
    );
  }

  @AdminGuard('dev', 'owner')
  @Post()
  create(
    @Req() request: AdminRequest,
    @Body() body: CreateRichMenuTemplateDto,
  ) {
    return this.richMenuService.create(
      tenantOf(request),
      body,
      request.admin?.id,
    );
  }

  /** Sends the listed users back to the default menu. */
  @AdminGuard('dev', 'owner')
  @Post('unlink')
  @HttpCode(200)
  unlinkUsers(@Req() request: AdminRequest, @Body() body: LinkRichMenuUsersDto) {
    return this.richMenuService.unlinkUsers(tenantOf(request), body);
  }

  /** Leaves the channel with no default menu at all. */
  @AdminGuard('dev', 'owner')
  @Delete('default')
  clearDefault(@Req() request: AdminRequest) {
    return this.richMenuService.clearDefault(tenantOf(request));
  }

  /** Removes a menu that is live on LINE but owned by no template. */
  @AdminGuard('dev', 'owner')
  @Delete('line/:richMenuId')
  removeOrphanOnLine(
    @Req() request: AdminRequest,
    @Param('richMenuId') richMenuId: string,
  ) {
    return this.richMenuService.removeOrphanOnLine(
      tenantOf(request),
      richMenuId,
    );
  }

  @Get(':id')
  get(
    @Req() request: AdminRequest,
    @Param() params: RichMenuTemplateIdParamDto,
  ) {
    return this.richMenuService.get(tenantOf(request), params.id);
  }

  /** Postback tap counts per area, from this bot's own webhook history. */
  @Get(':id/stats')
  stats(
    @Req() request: AdminRequest,
    @Param() params: RichMenuTemplateIdParamDto,
    @Query() query: RichMenuStatsQueryDto,
  ) {
    return this.richMenuService.stats(tenantOf(request), params.id, query);
  }

  @AdminGuard('dev', 'owner')
  @Patch(':id')
  update(
    @Req() request: AdminRequest,
    @Param() params: RichMenuTemplateIdParamDto,
    @Body() body: UpdateRichMenuTemplateDto,
  ) {
    return this.richMenuService.update(tenantOf(request), params.id, body);
  }

  /** Deletes the draft, its image, and the menu on LINE if it was published. */
  @AdminGuard('dev', 'owner')
  @Delete(':id')
  remove(
    @Req() request: AdminRequest,
    @Param() params: RichMenuTemplateIdParamDto,
  ) {
    return this.richMenuService.remove(tenantOf(request), params.id);
  }

  /** Multipart upload, field name `image`: PNG or JPEG, max 1MB. */
  @AdminGuard('dev', 'owner')
  @Post(':id/image')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  uploadImage(
    @Param() params: RichMenuTemplateIdParamDto,
    @Req() request: FastifyRequest & AdminRequest,
  ) {
    return this.richMenuService.uploadImage(
      tenantOf(request),
      params.id,
      request,
    );
  }

  /**
   * Lays the menu out as a grid of equal cells and binds each one to a reply.
   * This is what the back office calls when the tenant picks "6 buttons" and
   * chooses what each button answers.
   */
  @AdminGuard('dev', 'owner')
  @Put(':id/layout')
  @HttpCode(200)
  applyLayout(
    @Req() request: AdminRequest,
    @Param() params: RichMenuTemplateIdParamDto,
    @Body() body: ApplyRichMenuLayoutDto,
  ) {
    return this.richMenuService.applyLayout(
      tenantOf(request),
      params.id,
      body,
    );
  }

  /**
   * One button's artwork, field name `image`. It is resized to that cell and
   * the whole menu image is rebuilt around it, so the other cells keep theirs.
   */
  @AdminGuard('dev', 'owner')
  @Post(':id/cells/:index/image')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  uploadCellImage(
    @Param() params: RichMenuCellParamDto,
    @Req() request: FastifyRequest & AdminRequest,
  ) {
    return this.richMenuService.uploadCellImage(
      tenantOf(request),
      params.id,
      params.index,
      request,
    );
  }

  @AdminGuard('dev', 'owner')
  @Delete(':id/cells/:index/image')
  removeCellImage(
    @Req() request: AdminRequest,
    @Param() params: RichMenuCellParamDto,
  ) {
    return this.richMenuService.removeCellImage(
      tenantOf(request),
      params.id,
      params.index,
    );
  }

  /** Runs the draft past LINE's validator without creating anything. */
  @AdminGuard('dev', 'owner')
  @Post(':id/validate')
  @HttpCode(200)
  validate(
    @Req() request: AdminRequest,
    @Param() params: RichMenuTemplateIdParamDto,
  ) {
    return this.richMenuService.validate(tenantOf(request), params.id);
  }

  /** Create on LINE, upload the image, set the alias, optionally set default. */
  @AdminGuard('dev', 'owner')
  @Post(':id/publish')
  @HttpCode(200)
  publish(
    @Req() request: AdminRequest,
    @Param() params: RichMenuTemplateIdParamDto,
    @Body() body: PublishRichMenuTemplateDto,
  ) {
    return this.richMenuService.publish(tenantOf(request), params.id, body);
  }

  /** Makes this the menu every user sees unless they have a personal one. */
  @AdminGuard('dev', 'owner')
  @Post(':id/default')
  @HttpCode(200)
  setDefault(
    @Req() request: AdminRequest,
    @Param() params: RichMenuTemplateIdParamDto,
  ) {
    return this.richMenuService.setDefault(tenantOf(request), params.id);
  }

  /** Gives the listed users this menu instead of the default. */
  @AdminGuard('dev', 'owner')
  @Post(':id/link')
  @HttpCode(200)
  linkUsers(
    @Req() request: AdminRequest,
    @Param() params: RichMenuTemplateIdParamDto,
    @Body() body: LinkRichMenuUsersDto,
  ) {
    return this.richMenuService.linkUsers(tenantOf(request), params.id, body);
  }
}
