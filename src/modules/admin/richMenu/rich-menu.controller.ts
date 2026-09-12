import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiConsumes } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { RichMenuService } from './rich-menu.service';
import {
  CreateRichMenuTemplateDto,
  LineUserIdParamDto,
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
  list(@Query() query: ListRichMenuTemplateQueryDto) {
    return this.richMenuService.list(query);
  }

  /** Everything that currently exists on the LINE channel itself. */
  @Get('line')
  listOnLine() {
    return this.richMenuService.listOnLine();
  }

  /** Which menu one user is seeing right now. */
  @Get('users/:lineUserId')
  getUserMenu(@Param() params: LineUserIdParamDto) {
    return this.richMenuService.getUserMenu(params.lineUserId);
  }

  @AdminGuard('dev', 'owner')
  @Post()
  create(
    @Req() request: AdminRequest,
    @Body() body: CreateRichMenuTemplateDto,
  ) {
    return this.richMenuService.create(body, request.admin?.id);
  }

  /** Sends the listed users back to the default menu. */
  @AdminGuard('dev', 'owner')
  @Post('unlink')
  @HttpCode(200)
  unlinkUsers(@Body() body: LinkRichMenuUsersDto) {
    return this.richMenuService.unlinkUsers(body);
  }

  /** Leaves the channel with no default menu at all. */
  @AdminGuard('dev', 'owner')
  @Delete('default')
  clearDefault() {
    return this.richMenuService.clearDefault();
  }

  /** Removes a menu that is live on LINE but owned by no template. */
  @AdminGuard('dev', 'owner')
  @Delete('line/:richMenuId')
  removeOrphanOnLine(@Param('richMenuId') richMenuId: string) {
    return this.richMenuService.removeOrphanOnLine(richMenuId);
  }

  @Get(':id')
  get(@Param() params: RichMenuTemplateIdParamDto) {
    return this.richMenuService.get(params.id);
  }

  /** Postback tap counts per area, from this bot's own webhook history. */
  @Get(':id/stats')
  stats(
    @Param() params: RichMenuTemplateIdParamDto,
    @Query() query: RichMenuStatsQueryDto,
  ) {
    return this.richMenuService.stats(params.id, query);
  }

  @AdminGuard('dev', 'owner')
  @Patch(':id')
  update(
    @Param() params: RichMenuTemplateIdParamDto,
    @Body() body: UpdateRichMenuTemplateDto,
  ) {
    return this.richMenuService.update(params.id, body);
  }

  /** Deletes the draft, its image, and the menu on LINE if it was published. */
  @AdminGuard('dev', 'owner')
  @Delete(':id')
  remove(@Param() params: RichMenuTemplateIdParamDto) {
    return this.richMenuService.remove(params.id);
  }

  /** Multipart upload, field name `image`: PNG or JPEG, max 1MB. */
  @AdminGuard('dev', 'owner')
  @Post(':id/image')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  uploadImage(
    @Param() params: RichMenuTemplateIdParamDto,
    @Req() request: FastifyRequest,
  ) {
    return this.richMenuService.uploadImage(params.id, request);
  }

  /** Runs the draft past LINE's validator without creating anything. */
  @AdminGuard('dev', 'owner')
  @Post(':id/validate')
  @HttpCode(200)
  validate(@Param() params: RichMenuTemplateIdParamDto) {
    return this.richMenuService.validate(params.id);
  }

  /** Create on LINE, upload the image, set the alias, optionally set default. */
  @AdminGuard('dev', 'owner')
  @Post(':id/publish')
  @HttpCode(200)
  publish(
    @Param() params: RichMenuTemplateIdParamDto,
    @Body() body: PublishRichMenuTemplateDto,
  ) {
    return this.richMenuService.publish(params.id, body);
  }

  /** Makes this the menu every user sees unless they have a personal one. */
  @AdminGuard('dev', 'owner')
  @Post(':id/default')
  @HttpCode(200)
  setDefault(@Param() params: RichMenuTemplateIdParamDto) {
    return this.richMenuService.setDefault(params.id);
  }

  /** Gives the listed users this menu instead of the default. */
  @AdminGuard('dev', 'owner')
  @Post(':id/link')
  @HttpCode(200)
  linkUsers(
    @Param() params: RichMenuTemplateIdParamDto,
    @Body() body: LinkRichMenuUsersDto,
  ) {
    return this.richMenuService.linkUsers(params.id, body);
  }
}
