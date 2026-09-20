import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  LineChatMessageType,
  Prisma,
  RichMenuStatus,
  type RichMenuTemplate,
} from '../../../generated/prisma/client';
import {
  LineRichMenuClient,
  type LineRichMenuPayload,
} from './line-rich-menu.client';
import { readImageDimensions } from './image-size';
import { RichMenuImageService } from './rich-menu-image.service';
import { lineChannelTenantId } from './line-channel-tenant';
import { encodeMenuReplyPostback } from '../../../shared/richMenu/menu-postback';
import {
  RICH_MENU_CELL_LAYOUTS,
  RICH_MENU_IMAGE_ALLOWED_EXTENSIONS,
  RICH_MENU_IMAGE_MAX_BYTES,
  RICH_MENU_IMAGE_MIME_TO_EXTENSION,
  RICH_MENU_UPLOAD_URL_PREFIX,
} from './rich-menu.constants';
import {
  richMenuAreasSchema,
  richMenuCellImagesSchema,
  type ApplyRichMenuLayoutDto,
  type CreateRichMenuTemplateDto,
  type RichMenuCellImage,
  type LinkRichMenuUsersDto,
  type ListRichMenuTemplateQueryDto,
  type PublishRichMenuTemplateDto,
  type RichMenuArea,
  type RichMenuStatsQueryDto,
  type UpdateRichMenuTemplateDto,
} from './dto/rich-menu.dto';

const RICH_MENU_UPLOAD_DIR = join(process.cwd(), 'uploads', 'richmenu');

const STATS_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type RichMenuTemplateView = Omit<
  RichMenuTemplate,
  'areas' | 'cellImages'
> & {
  areas: RichMenuArea[];
  cellImages: RichMenuCellImage[];
  /** Ready to POST to LINE as-is; handy for previewing what publish will send. */
  linePayload: LineRichMenuPayload;
};

/**
 * Back-office CRUD for rich menu drafts, plus the publish sequence that puts
 * one on LINE (create JSON -> upload image -> alias -> default/user link).
 *
 * A rich menu cannot be edited on LINE, so publishing an already-published
 * template creates a fresh `richMenuId` and retires the previous one.
 */
@Injectable()
export class RichMenuService {
  private afterCommit?: Array<() => Promise<void>>;
  private afterRollback?: Array<() => Promise<void>>;
  private readonly logger = new Logger(RichMenuService.name);
  /** The only tenant allowed to write to the LINE channel; see the helper. */
  private readonly channelTenantId: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lineClient: LineRichMenuClient,
    private readonly images: RichMenuImageService,
    config: ConfigService,
  ) {
    this.channelTenantId = lineChannelTenantId(config);
  }

  async list(
    tenantId: string | null,
    query: ListRichMenuTemplateQueryDto,
  ): Promise<RichMenuTemplateView[]> {
    const templates = await this.prisma.richMenuTemplate.findMany({
      where: { tenantId, status: query.status },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });

    return templates.map((template) => this.toView(template));
  }

  async get(
    tenantId: string | null,
    id: string,
  ): Promise<RichMenuTemplateView> {
    return this.toView(await this.findOrThrow(tenantId, id));
  }

  async create(
    tenantId: string | null,
    dto: CreateRichMenuTemplateDto,
    adminId?: string,
  ): Promise<RichMenuTemplateView> {
    const template = await this.prisma.richMenuTemplate.create({
      data: {
        tenantId,
        name: dto.name,
        chatBarText: dto.chatBarText,
        width: dto.size.width,
        height: dto.size.height,
        selected: dto.selected,
        areas: dto.areas,
        lineAliasId: dto.aliasId ?? null,
        createdByAdminId: adminId ?? null,
      },
    });

    return this.toView(template);
  }

  /**
   * Edits the draft only. A published template keeps serving its current
   * revision on LINE until it is published again, which `needsRepublish` flags.
   */
  async update(
    tenantId: string | null,
    id: string,
    dto: UpdateRichMenuTemplateDto,
  ): Promise<RichMenuTemplateView> {
    return this.withTemplateLock(tenantId, id, (service) =>
      service.updateLocked(tenantId, id, dto),
    );
  }

  private async updateLocked(
    tenantId: string | null,
    id: string,
    dto: UpdateRichMenuTemplateDto,
  ): Promise<RichMenuTemplateView> {
    const existing = await this.findOrThrow(tenantId, id);

    const width = dto.size?.width ?? existing.width;
    const height = dto.size?.height ?? existing.height;
    const areas = dto.areas ?? this.parseAreas(existing);

    // A partial update can change the size or the areas alone, so the merged
    // result is what has to fit — not whichever half arrived in the body.
    this.assertAreasFit(areas, width, height);

    const updated = await this.prisma.richMenuTemplate.update({
      where: { id },
      data: {
        name: dto.name,
        chatBarText: dto.chatBarText,
        width: dto.size?.width,
        height: dto.size?.height,
        selected: dto.selected,
        areas: dto.areas
          ? (dto.areas as unknown as Prisma.InputJsonValue)
          : undefined,
        lineAliasId: dto.aliasId === undefined ? undefined : dto.aliasId,
        needsRepublish: existing.lineRichMenuId ? true : undefined,
      },
    });

    return dto.size ? this.recomposite(updated) : this.toView(updated);
  }

  async remove(
    tenantId: string | null,
    id: string,
  ): Promise<{ id: string; deletedFromLine: boolean }> {
    const template = await this.findOrThrow(tenantId, id);
    this.assertOwnsChannel(tenantId, template.lineRichMenuId !== null);

    let deletedFromLine = false;

    if (template.lineRichMenuId) {
      // A menu already removed on LINE must not block deleting our own row.
      try {
        await this.lineClient.remove(template.lineRichMenuId);
        deletedFromLine = true;
      } catch (error) {
        this.logger.warn(
          `Rich menu ${template.lineRichMenuId} not deleted on LINE: ${String(error)}`,
        );
      }
    }

    if (template.lineAliasId) {
      await this.lineClient
        .deleteAlias(template.lineAliasId)
        .catch(() => undefined);
    }

    await this.prisma.richMenuTemplate.delete({ where: { id } });
    await this.deleteStoredImage(template.imagePath);
    await this.images.removeCellImages(this.parseCellImages(template));

    return { id, deletedFromLine };
  }

  /**
   * Stores the menu image locally. It is sent to LINE at publish time, so the
   * image can be replaced as often as the draft needs without touching LINE.
   */
  async uploadImage(
    tenantId: string | null,
    id: string,
    request: FastifyRequest,
  ): Promise<RichMenuTemplateView> {
    return this.withTemplateLock(tenantId, id, (service) =>
      service.uploadImageLocked(tenantId, id, request),
    );
  }

  private async uploadImageLocked(
    tenantId: string | null,
    id: string,
    request: FastifyRequest,
  ): Promise<RichMenuTemplateView> {
    const template = await this.findOrThrow(tenantId, id);

    const upload = await this.readUploadedImage(request);
    const imageBuffer = upload.buffer;
    const mimeType = upload.mimeType;
    const extension = upload.extension;

    const dimensions = readImageDimensions(imageBuffer);
    if (!dimensions) {
      throw new BadRequestException('Could not read the image dimensions');
    }

    if (
      dimensions.width !== template.width ||
      dimensions.height !== template.height
    ) {
      throw new BadRequestException(
        `Image is ${dimensions.width}x${dimensions.height} but the menu is ${template.width}x${template.height}`,
      );
    }

    await mkdir(RICH_MENU_UPLOAD_DIR, { recursive: true });

    const filename = `${randomUUID()}${extension}`;
    const imagePath = `${RICH_MENU_UPLOAD_URL_PREFIX}/${filename}`;
    await writeFile(join(RICH_MENU_UPLOAD_DIR, filename), imageBuffer);
    this.afterRollback?.push(() => this.deleteStoredImageNow(imagePath));

    try {
      const updated = await this.prisma.richMenuTemplate.update({
        where: { id },
        data: {
          imagePath,
          imageMimeType: mimeType,
          imageBytes: imageBuffer.length,
          cellImages: [],
          needsRepublish: template.lineRichMenuId ? true : undefined,
        },
      });

      await this.deleteStoredImage(template.imagePath);
      await this.removeCellFiles(this.parseCellImages(template));

      return this.toView(updated);
    } catch (error) {
      await this.deleteStoredImage(imagePath);
      throw error;
    }
  }

  /**
   * Divides the menu into `cells` equal regions and binds each one to a reply
   * the tenant already wrote.
   *
   * This is the tenant-facing way to build a menu: pick how many buttons, pick
   * what each one answers, upload one image per button. The LINE `areas` array
   * and the `menu=<key>` postbacks are derived from that, so a tenant never
   * types coordinates or postback strings.
   */
  async applyLayout(
    tenantId: string | null,
    id: string,
    dto: ApplyRichMenuLayoutDto,
  ): Promise<RichMenuTemplateView> {
    return this.withTemplateLock(tenantId, id, (service) =>
      service.applyLayoutLocked(tenantId, id, dto),
    );
  }

  private async applyLayoutLocked(
    tenantId: string | null,
    id: string,
    dto: ApplyRichMenuLayoutDto,
  ): Promise<RichMenuTemplateView> {
    const template = await this.findOrThrow(tenantId, id);
    const rects = this.images.cellRects(
      dto.cells,
      template.width,
      template.height,
    );

    const replyKeys = dto.buttons
      .map((button) => button?.replyKey)
      .filter((key): key is string => Boolean(key));

    const replies = replyKeys.length
      ? await this.prisma.richMenuReply.findMany({
          where: { tenantId, key: { in: replyKeys } },
        })
      : [];

    const replyByKey = new Map(replies.map((reply) => [reply.key, reply]));
    const missing = replyKeys.filter((key) => !replyByKey.has(key));

    if (missing.length) {
      throw new BadRequestException(
        `No rich menu reply exists for: ${missing.join(', ')}`,
      );
    }

    const areas: RichMenuArea[] = [];

    dto.buttons.slice(0, dto.cells).forEach((button, index) => {
      if (!button) return;

      const rect = rects[index];
      const bounds = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };

      if (button.uri) {
        areas.push({ bounds, action: { type: 'uri', uri: button.uri } });
        return;
      }

      if (button.action) {
        areas.push({ bounds, action: button.action });
        return;
      }

      const reply = replyByKey.get(button.replyKey!)!;

      areas.push({
        bounds,
        action: {
          type: 'postback',
          label: reply.label.slice(0, 20),
          data: encodeMenuReplyPostback(reply.key),
          // Echoes the caption into the chat, so the conversation reads as if
          // the customer asked for it — and typing it by hand lands in the
          // same place.
          displayText: reply.label.slice(0, 300),
        },
      });
    });

    if (!areas.length) {
      throw new BadRequestException(
        'A menu needs at least one button; bind a reply or a link to one cell',
      );
    }

    // Images for cells that no longer exist would never be composited again.
    const keptCells = this.parseCellImages(template).filter(
      (cell) => cell.index < dto.cells,
    );
    const droppedCells = this.parseCellImages(template).filter(
      (cell) => cell.index >= dto.cells,
    );

    const updated = await this.prisma.richMenuTemplate.update({
      where: { id: template.id },
      data: {
        cellCount: dto.cells,
        areas: areas,
        cellImages: keptCells,
        needsRepublish: template.lineRichMenuId ? true : undefined,
      },
    });

    await this.removeCellFiles(droppedCells);

    // The grid changed, so every stored cell sits in a new rect.
    return this.recomposite(updated, this.parseCellImages(template).length > 0);
  }

  /**
   * Replaces one cell's artwork and rebuilds the menu image around it.
   *
   * The composited result is written to `imagePath` immediately so preview,
   * validate and publish all read one already-correct image rather than
   * compositing again at publish time.
   */
  async uploadCellImage(
    tenantId: string | null,
    id: string,
    index: number,
    request: FastifyRequest,
  ): Promise<RichMenuTemplateView> {
    return this.withTemplateLock(tenantId, id, (service) =>
      service.uploadCellImageLocked(tenantId, id, index, request),
    );
  }

  private async uploadCellImageLocked(
    tenantId: string | null,
    id: string,
    index: number,
    request: FastifyRequest,
  ): Promise<RichMenuTemplateView> {
    const template = await this.findOrThrow(tenantId, id);
    const cellCount = this.cellCountOf(template);
    const rects = this.images.cellRects(
      cellCount,
      template.width,
      template.height,
    );
    const rect = rects[index];

    if (!rect) {
      throw new BadRequestException(
        `This menu has ${cellCount} cells, so cell ${index} does not exist`,
      );
    }

    const upload = await this.readUploadedImage(request);
    const stored = await this.images.storeCell(upload.buffer, rect);
    this.afterRollback?.push(() => this.images.removeCellImages([stored]));

    const previous = this.parseCellImages(template);
    const cells = [
      ...previous.filter((cell) => cell.index !== index),
      stored,
    ].sort((left, right) => left.index - right.index);

    const updated = await this.prisma.richMenuTemplate.update({
      where: { id: template.id },
      data: {
        cellImages: cells,
        needsRepublish: template.lineRichMenuId ? true : undefined,
      },
    });

    const view = await this.recomposite(updated);

    await this.removeCellFiles(previous.filter((cell) => cell.index === index));

    return view;
  }

  async removeCellImage(
    tenantId: string | null,
    id: string,
    index: number,
  ): Promise<RichMenuTemplateView> {
    return this.withTemplateLock(tenantId, id, (service) =>
      service.removeCellImageLocked(tenantId, id, index),
    );
  }

  private async removeCellImageLocked(
    tenantId: string | null,
    id: string,
    index: number,
  ): Promise<RichMenuTemplateView> {
    const template = await this.findOrThrow(tenantId, id);
    const previous = this.parseCellImages(template);
    const removed = previous.filter((cell) => cell.index === index);

    if (!removed.length) {
      throw new NotFoundException(`Cell ${index} has no image`);
    }

    const updated = await this.prisma.richMenuTemplate.update({
      where: { id: template.id },
      data: {
        cellImages: previous.filter((cell) => cell.index !== index),
        needsRepublish: template.lineRichMenuId ? true : undefined,
      },
    });

    const view = await this.recomposite(updated, true);
    await this.removeCellFiles(removed);

    return view;
  }

  /**
   * Flattens the stored cells into the single image LINE accepts and saves it
   * as this template's menu image. A menu with no cell images keeps whatever
   * full-canvas image was uploaded directly.
   */
  private async recomposite(
    template: RichMenuTemplate,
    clearEmpty = false,
  ): Promise<RichMenuTemplateView> {
    const cells = this.parseCellImages(template);

    if (!cells.length) {
      if (!clearEmpty) return this.toView(template);
      const updated = await this.prisma.richMenuTemplate.update({
        where: { id: template.id },
        data: { imagePath: null, imageMimeType: null, imageBytes: null },
      });
      await this.deleteStoredImage(template.imagePath);
      return this.toView(updated);
    }

    const composited = await this.images.composite(
      this.cellCountOf(template),
      cells,
      template.width,
      template.height,
    );

    const extension = composited.mimeType === 'image/png' ? '.png' : '.jpg';
    const filename = `${randomUUID()}${extension}`;
    const imagePath = `${RICH_MENU_UPLOAD_URL_PREFIX}/${filename}`;

    await mkdir(RICH_MENU_UPLOAD_DIR, { recursive: true });
    await writeFile(join(RICH_MENU_UPLOAD_DIR, filename), composited.buffer);
    this.afterRollback?.push(() => this.deleteStoredImageNow(imagePath));

    try {
      const updated = await this.prisma.richMenuTemplate.update({
        where: { id: template.id },
        data: {
          imagePath,
          imageMimeType: composited.mimeType,
          imageBytes: composited.buffer.length,
        },
      });

      await this.deleteStoredImage(template.imagePath);

      return this.toView(updated);
    } catch (error) {
      await this.deleteStoredImage(imagePath);
      throw error;
    }
  }

  /**
   * How many cells this menu is divided into.
   *
   * `cellCount` is authoritative. Only a menu built before per-cell images has
   * none, and for those the areas are the whole grid, so counting them is
   * exact — a decorative cell, which has no area, cannot exist there yet.
   */
  private cellCountOf(template: RichMenuTemplate): number {
    if (template.cellCount) return template.cellCount;

    const areas = this.parseAreas(template);
    const stored = this.parseCellImages(template);
    const highestCell = stored.reduce(
      (highest, cell) => Math.max(highest, cell.index + 1),
      0,
    );

    const cells = RICH_MENU_CELL_LAYOUTS.map((layout) => layout.cells)
      .sort((left, right) => left - right)
      .find((candidate) => candidate >= Math.max(areas.length, highestCell));

    if (!cells) {
      throw new BadRequestException(
        `A ${areas.length}-button menu does not match any supported cell layout`,
      );
    }

    return cells;
  }

  /**
   * One publish is five LINE calls: validate, create, upload the image,
   * point the alias at the new id, and set it as the default or leave it
   * unlinked. A half-created menu is deleted again so the channel does not
   * collect orphans, and the previous revision is retired only after the new
   * one is live.
   */
  async publish(
    tenantId: string | null,
    id: string,
    dto: PublishRichMenuTemplateDto,
  ): Promise<RichMenuTemplateView> {
    const template = await this.findOrThrow(tenantId, id);
    this.assertOwnsChannel(tenantId);

    if (!template.imagePath || !template.imageMimeType) {
      throw new BadRequestException(
        'Upload a menu image before publishing to LINE',
      );
    }

    const image = await this.readStoredImage(template.imagePath);
    const payload = this.toLinePayload(template);
    const previousRichMenuId = template.lineRichMenuId;
    // Keeping an already-default menu default is not optional: replacing it
    // without re-pointing the default would leave users with no menu at all.
    const shouldSetDefault = dto.setAsDefault || template.isDefault;

    await this.lineClient.validate(payload);

    let richMenuId: string | undefined;

    try {
      richMenuId = await this.lineClient.create(payload);
      await this.lineClient.uploadImage(
        richMenuId,
        image,
        template.imageMimeType,
      );

      if (template.lineAliasId) {
        await this.lineClient.upsertAlias(template.lineAliasId, richMenuId);
      }

      if (shouldSetDefault) {
        await this.lineClient.setDefault(richMenuId);
      }
    } catch (error) {
      if (richMenuId) {
        await this.lineClient.remove(richMenuId).catch(() => undefined);
      }

      await this.prisma.richMenuTemplate.update({
        where: { id },
        data: { lastPublishError: this.describeError(error) },
      });

      throw error;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (shouldSetDefault) {
        await tx.richMenuTemplate.updateMany({
          where: { tenantId, id: { not: id }, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.richMenuTemplate.update({
        where: { id },
        data: {
          status: RichMenuStatus.PUBLISHED,
          lineRichMenuId: richMenuId,
          isDefault: shouldSetDefault,
          needsRepublish: false,
          lastPublishError: null,
          publishedAt: new Date(),
        },
      });
    });

    if (previousRichMenuId && previousRichMenuId !== richMenuId) {
      await this.lineClient
        .remove(previousRichMenuId)
        .catch((error: unknown) =>
          this.logger.warn(
            `Published ${richMenuId}; retiring ${previousRichMenuId} failed: ${String(error)}`,
          ),
        );
    }

    return this.toView(updated);
  }

  /** Points every user without a personal menu at this template. */
  async setDefault(
    tenantId: string | null,
    id: string,
  ): Promise<RichMenuTemplateView> {
    const template = await this.findPublishedOrThrow(tenantId, id);
    this.assertOwnsChannel(tenantId);

    await this.lineClient.setDefault(template.lineRichMenuId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.richMenuTemplate.updateMany({
        where: { tenantId, id: { not: id }, isDefault: true },
        data: { isDefault: false },
      });

      return tx.richMenuTemplate.update({
        where: { id },
        data: { isDefault: true },
      });
    });

    return this.toView(updated);
  }

  async clearDefault(tenantId: string | null): Promise<{ cleared: boolean }> {
    this.assertOwnsChannel(tenantId);

    await this.lineClient.clearDefault();

    await this.prisma.richMenuTemplate.updateMany({
      where: { tenantId, isDefault: true },
      data: { isDefault: false },
    });

    return { cleared: true };
  }

  /** Per-user menus win over the default, so each user can see a different one. */
  async linkUsers(
    tenantId: string | null,
    id: string,
    dto: LinkRichMenuUsersDto,
  ): Promise<{ richMenuId: string; linked: number }> {
    const template = await this.findPublishedOrThrow(tenantId, id);
    this.assertOwnsChannel(tenantId);

    if (dto.lineUserIds.length === 1) {
      await this.lineClient.linkUser(
        dto.lineUserIds[0],
        template.lineRichMenuId,
      );
    } else {
      await this.lineClient.bulkLink(dto.lineUserIds, template.lineRichMenuId);
    }

    return {
      richMenuId: template.lineRichMenuId,
      linked: dto.lineUserIds.length,
    };
  }

  async unlinkUsers(
    tenantId: string | null,
    dto: LinkRichMenuUsersDto,
  ): Promise<{ unlinked: number }> {
    this.assertOwnsChannel(tenantId);

    if (dto.lineUserIds.length === 1) {
      await this.lineClient.unlinkUser(dto.lineUserIds[0]);
    } else {
      await this.lineClient.bulkUnlink(dto.lineUserIds);
    }

    return { unlinked: dto.lineUserIds.length };
  }

  async getUserMenu(
    tenantId: string | null,
    lineUserId: string,
  ): Promise<{
    lineUserId: string;
    richMenuId: string | null;
    template: RichMenuTemplateView | null;
  }> {
    this.assertOwnsChannel(tenantId);

    const richMenuId = await this.lineClient.getUserMenu(lineUserId);

    if (!richMenuId) {
      return { lineUserId, richMenuId: null, template: null };
    }

    // Scoped: a menu belonging to another tenant reads back as untracked
    // rather than leaking that tenant's template.
    const template = await this.prisma.richMenuTemplate.findFirst({
      where: { tenantId, lineRichMenuId: richMenuId },
    });

    return {
      lineUserId,
      richMenuId,
      template: template ? this.toView(template) : null,
    };
  }

  /**
   * What actually exists on the LINE channel right now, each entry matched
   * back to its template. An untracked entry is a leftover from a publish
   * that was never retired and can be deleted safely.
   */
  async listOnLine(tenantId: string | null) {
    this.assertOwnsChannel(tenantId);

    const [menus, defaultRichMenuId, templates, aliases] = await Promise.all([
      this.lineClient.list(),
      this.lineClient.getDefault(),
      this.prisma.richMenuTemplate.findMany({
        where: { tenantId, lineRichMenuId: { not: null } },
        select: { id: true, name: true, lineRichMenuId: true },
      }),
      this.lineClient.listAliases(),
    ]);

    const templateByLineId = new Map(
      templates.map((template) => [template.lineRichMenuId, template]),
    );

    return {
      defaultRichMenuId,
      aliases,
      menus: menus.map((menu) => {
        const template = templateByLineId.get(menu.richMenuId);

        return {
          ...menu,
          isDefault: menu.richMenuId === defaultRichMenuId,
          templateId: template?.id ?? null,
          templateName: template?.name ?? null,
          /** Live on LINE but not owned by any draft here. */
          orphaned: !template,
        };
      }),
    };
  }

  /** Deletes a menu that exists on LINE but is not tracked by any template. */
  async removeOrphanOnLine(
    tenantId: string | null,
    richMenuId: string,
  ): Promise<{ richMenuId: string; deleted: boolean }> {
    this.assertOwnsChannel(tenantId);

    // Deliberately unscoped: a menu owned by any tenant is not an orphan, and
    // deleting it would take down a menu this caller cannot even see.
    const owner = await this.prisma.richMenuTemplate.findUnique({
      where: { lineRichMenuId: richMenuId },
      select: { id: true, tenantId: true },
    });

    if (owner) {
      throw new ConflictException(
        owner.tenantId === tenantId
          ? `Rich menu ${richMenuId} belongs to template ${owner.id}; delete the template instead`
          : `Rich menu ${richMenuId} belongs to another tenant`,
      );
    }

    await this.lineClient.remove(richMenuId);

    return { richMenuId, deleted: true };
  }

  /**
   * Tap counts per area, from the postback events this bot actually received.
   *
   * LINE has no public rich menu statistics API, so only `postback` areas can
   * be counted — `uri` and `message` taps never reach the webhook as a
   * postback, and `uri` taps never reach it at all.
   */
  async stats(
    tenantId: string | null,
    id: string,
    query: RichMenuStatsQueryDto,
  ) {
    const template = await this.findOrThrow(tenantId, id);
    const areas = this.parseAreas(template);

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - STATS_DEFAULT_WINDOW_MS);

    const postbackAreas = areas.filter(
      (area) => area.action.type === 'postback',
    );
    const postbackData = postbackAreas.map((area) =>
      area.action.type === 'postback' ? area.action.data : '',
    );

    const counts = postbackData.length
      ? await this.prisma.lineChatHistory.groupBy({
          by: ['postbackData'],
          where: {
            messageType: LineChatMessageType.POSTBACK,
            postbackData: { in: postbackData },
            createdAt: { gte: from, lte: to },
          },
          _count: { _all: true },
        })
      : [];

    const countByData = new Map(
      counts.map((row) => [row.postbackData, row._count._all]),
    );

    const areaStats = postbackAreas.map((area) => {
      const data = area.action.type === 'postback' ? area.action.data : '';

      return {
        label: area.action.label ?? null,
        data,
        bounds: area.bounds,
        taps: countByData.get(data) ?? 0,
      };
    });

    return {
      templateId: template.id,
      from: from.toISOString(),
      to: to.toISOString(),
      totalTaps: areaStats.reduce((sum, area) => sum + area.taps, 0),
      /** Areas whose taps LINE never reports back to the bot. */
      untrackedAreas: areas.length - postbackAreas.length,
      areas: areaStats,
    };
  }

  /** Runs the draft past LINE's own validator without creating anything. */
  async validate(
    tenantId: string | null,
    id: string,
  ): Promise<{ valid: true }> {
    const template = await this.findOrThrow(tenantId, id);
    this.assertOwnsChannel(tenantId);
    await this.lineClient.validate(this.toLinePayload(template));

    return { valid: true };
  }

  /** Serialize read/compose/write across processes, using the same DB row lock. */
  private async withTemplateLock(
    tenantId: string | null,
    id: string,
    run: (service: RichMenuService) => Promise<RichMenuTemplateView>,
  ): Promise<RichMenuTemplateView> {
    const cleanup: Array<() => Promise<void>> = [];
    const rollback: Array<() => Promise<void>> = [];
    const result = await this.prisma
      .$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "richMenuTemplate"
        WHERE "id" = ${id}::uuid
          AND "tenantId" IS NOT DISTINCT FROM ${tenantId}::uuid
        FOR UPDATE
      `);
          if (!rows.length)
            throw new NotFoundException('Rich menu template not found');
          const service = new RichMenuService(
            tx as PrismaService,
            this.lineClient,
            this.images,
            new ConfigService({}),
          );
          service.afterCommit = cleanup;
          service.afterRollback = rollback;
          return run(service);
        },
        { timeout: 60_000, maxWait: 10_000 },
      )
      .catch(async (error: unknown) => {
        await Promise.all(rollback.map((remove) => remove()));
        throw error;
      });
    await Promise.all(cleanup.map((remove) => remove()));
    return result;
  }

  private async removeCellFiles(cells: RichMenuCellImage[]): Promise<void> {
    if (this.afterCommit) {
      this.afterCommit.push(() => this.images.removeCellImages(cells));
      return;
    }
    await this.images.removeCellImages(cells);
  }

  private async findOrThrow(
    tenantId: string | null,
    id: string,
  ): Promise<RichMenuTemplate> {
    const template = await this.prisma.richMenuTemplate.findFirst({
      where: { id, tenantId },
    });

    if (!template) {
      throw new NotFoundException(`Rich menu template ${id} not found`);
    }

    return template;
  }

  private async findPublishedOrThrow(
    tenantId: string | null,
    id: string,
  ): Promise<RichMenuTemplate & { lineRichMenuId: string }> {
    const template = await this.findOrThrow(tenantId, id);

    if (!template.lineRichMenuId) {
      throw new ConflictException(
        'Publish the template to LINE before linking it to users',
      );
    }

    return template as RichMenuTemplate & { lineRichMenuId: string };
  }

  private toLinePayload(template: RichMenuTemplate): LineRichMenuPayload {
    return {
      size: { width: template.width, height: template.height },
      selected: template.selected,
      name: template.name,
      chatBarText: template.chatBarText,
      areas: this.parseAreas(template),
    };
  }

  private toView(template: RichMenuTemplate): RichMenuTemplateView {
    return {
      ...template,
      areas: this.parseAreas(template),
      cellImages: this.parseCellImages(template),
      linePayload: this.toLinePayload(template),
    };
  }

  /**
   * Refuses anything that writes to the LINE channel when the caller is not
   * the tenant that owns it. Drafting, answering and reading stay available to
   * every tenant; only the shared channel is fenced off.
   */
  private assertOwnsChannel(tenantId: string | null, applies = true): void {
    if (!applies || tenantId === this.channelTenantId) return;

    throw new ForbiddenException(
      'This deployment holds the LINE channel token for another tenant, so its rich menus cannot be changed from here',
    );
  }

  /** `cellImages` is a JSON column; an unreadable value is treated as empty. */
  private parseCellImages(template: RichMenuTemplate): RichMenuCellImage[] {
    if (template.cellImages === null || template.cellImages === undefined) {
      return [];
    }

    const parsed = richMenuCellImagesSchema.safeParse(template.cellImages);

    return parsed.success ? parsed.data : [];
  }

  /** `areas` is a JSON column; re-parsing keeps a hand-edited row from leaking through. */
  private parseAreas(template: RichMenuTemplate): RichMenuArea[] {
    const parsed = richMenuAreasSchema.safeParse(template.areas);

    if (!parsed.success) {
      throw new BadRequestException(
        `Rich menu template ${template.id} has invalid areas`,
      );
    }

    return parsed.data;
  }

  private assertAreasFit(
    areas: RichMenuArea[],
    width: number,
    height: number,
  ): void {
    areas.forEach((area, index) => {
      const bounds = area.bounds;

      if (
        bounds.x + bounds.width > width ||
        bounds.y + bounds.height > height
      ) {
        throw new BadRequestException(
          `areas[${index}] is outside the ${width}x${height} menu`,
        );
      }
    });
  }

  /**
   * Pulls the single `image` part out of a multipart request.
   *
   * Format and size are checked here because both come from LINE's own limits;
   * whether the pixels fit the menu is the caller's business, since a cell
   * upload is resized to fit while a full-canvas upload must already match.
   */
  private async readUploadedImage(request: FastifyRequest): Promise<{
    buffer: Buffer;
    mimeType: string;
    extension: string;
  }> {
    if (!request.isMultipart()) {
      throw new BadRequestException('A multipart image file is required');
    }

    let buffer: Buffer | undefined;
    let mimeType = '';
    let extension = '';

    try {
      for await (const part of request.parts({
        limits: { files: 1, fileSize: RICH_MENU_IMAGE_MAX_BYTES },
      })) {
        if (part.type !== 'file') continue;

        if (part.fieldname !== 'image' || buffer) {
          throw new BadRequestException(
            'Only one image file is allowed in the image field',
          );
        }

        const clientExtension = extname(part.filename).toLowerCase();
        if (
          !RICH_MENU_IMAGE_ALLOWED_EXTENSIONS.includes(
            clientExtension as (typeof RICH_MENU_IMAGE_ALLOWED_EXTENSIONS)[number],
          )
        ) {
          throw new BadRequestException(
            `Unsupported image extension. Allowed: ${RICH_MENU_IMAGE_ALLOWED_EXTENSIONS.join(', ')}`,
          );
        }

        extension = RICH_MENU_IMAGE_MIME_TO_EXTENSION[part.mimetype];
        if (!extension) {
          throw new BadRequestException(
            `Unsupported image type. LINE accepts ${Object.keys(
              RICH_MENU_IMAGE_MIME_TO_EXTENSION,
            ).join(', ')}`,
          );
        }

        mimeType = part.mimetype;
        buffer = await part.toBuffer();

        if (part.file.truncated) {
          throw new BadRequestException(
            `Image exceeds the LINE limit of ${RICH_MENU_IMAGE_MAX_BYTES / 1024}KB`,
          );
        }
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Invalid multipart image upload');
    }

    if (!buffer || !extension) {
      throw new BadRequestException('An image file is required');
    }

    return { buffer, mimeType, extension };
  }

  private async readStoredImage(imagePath: string): Promise<Buffer> {
    const filename = imagePath.slice(RICH_MENU_UPLOAD_URL_PREFIX.length + 1);

    try {
      return await readFile(join(RICH_MENU_UPLOAD_DIR, filename));
    } catch {
      throw new BadRequestException(
        'The stored menu image is missing; upload it again before publishing',
      );
    }
  }

  private async deleteStoredImage(imagePath: string | null): Promise<void> {
    if (this.afterCommit) {
      this.afterCommit.push(() => this.deleteStoredImageNow(imagePath));
      return;
    }
    await this.deleteStoredImageNow(imagePath);
  }

  private async deleteStoredImageNow(imagePath: string | null): Promise<void> {
    if (!imagePath?.startsWith(`${RICH_MENU_UPLOAD_URL_PREFIX}/`)) return;

    const filename = imagePath.slice(RICH_MENU_UPLOAD_URL_PREFIX.length + 1);

    try {
      await unlink(join(RICH_MENU_UPLOAD_DIR, filename));
    } catch {
      // Best-effort cleanup; a missing file is not an error.
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 1000);
    return String(error).slice(0, 1000);
  }
}
