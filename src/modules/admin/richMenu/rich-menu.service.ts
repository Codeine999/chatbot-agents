import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
import { LineRichMenuClient, type LineRichMenuPayload } from './line-rich-menu.client';
import { readImageDimensions } from './image-size';
import {
  RICH_MENU_IMAGE_ALLOWED_EXTENSIONS,
  RICH_MENU_IMAGE_MAX_BYTES,
  RICH_MENU_IMAGE_MIME_TO_EXTENSION,
  RICH_MENU_UPLOAD_URL_PREFIX,
} from './rich-menu.constants';
import {
  richMenuAreasSchema,
  type CreateRichMenuTemplateDto,
  type LinkRichMenuUsersDto,
  type ListRichMenuTemplateQueryDto,
  type PublishRichMenuTemplateDto,
  type RichMenuArea,
  type RichMenuStatsQueryDto,
  type UpdateRichMenuTemplateDto,
} from './dto/rich-menu.dto';

const RICH_MENU_UPLOAD_DIR = join(process.cwd(), 'uploads', 'richmenu');

const STATS_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type RichMenuTemplateView = Omit<RichMenuTemplate, 'areas'> & {
  areas: RichMenuArea[];
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
  private readonly logger = new Logger(RichMenuService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lineClient: LineRichMenuClient,
  ) {}

  async list(
    query: ListRichMenuTemplateQueryDto,
  ): Promise<RichMenuTemplateView[]> {
    const templates = await this.prisma.richMenuTemplate.findMany({
      where: { status: query.status },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });

    return templates.map((template) => this.toView(template));
  }

  async get(id: string): Promise<RichMenuTemplateView> {
    return this.toView(await this.findOrThrow(id));
  }

  async create(
    dto: CreateRichMenuTemplateDto,
    adminId?: string,
  ): Promise<RichMenuTemplateView> {
    const template = await this.prisma.richMenuTemplate.create({
      data: {
        name: dto.name,
        chatBarText: dto.chatBarText,
        width: dto.size.width,
        height: dto.size.height,
        selected: dto.selected,
        areas: dto.areas as unknown as Prisma.InputJsonValue,
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
    id: string,
    dto: UpdateRichMenuTemplateDto,
  ): Promise<RichMenuTemplateView> {
    const existing = await this.findOrThrow(id);

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

    return this.toView(updated);
  }

  async remove(id: string): Promise<{ id: string; deletedFromLine: boolean }> {
    const template = await this.findOrThrow(id);

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

    return { id, deletedFromLine };
  }

  /**
   * Stores the menu image locally. It is sent to LINE at publish time, so the
   * image can be replaced as often as the draft needs without touching LINE.
   */
  async uploadImage(
    id: string,
    request: FastifyRequest,
  ): Promise<RichMenuTemplateView> {
    const template = await this.findOrThrow(id);

    if (!request.isMultipart()) {
      throw new BadRequestException('A multipart image file is required');
    }

    let imageBuffer: Buffer | undefined;
    let mimeType = '';
    let extension = '';

    try {
      for await (const part of request.parts({
        limits: { files: 1, fileSize: RICH_MENU_IMAGE_MAX_BYTES },
      })) {
        if (part.type !== 'file') continue;

        if (part.fieldname !== 'image' || imageBuffer) {
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
        imageBuffer = await part.toBuffer();

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

    if (!imageBuffer || !extension) {
      throw new BadRequestException('An image file is required');
    }

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

    try {
      const updated = await this.prisma.richMenuTemplate.update({
        where: { id },
        data: {
          imagePath,
          imageMimeType: mimeType,
          imageBytes: imageBuffer.length,
          needsRepublish: template.lineRichMenuId ? true : undefined,
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
   * One publish is five LINE calls: validate, create, upload the image,
   * point the alias at the new id, and set it as the default or leave it
   * unlinked. A half-created menu is deleted again so the channel does not
   * collect orphans, and the previous revision is retired only after the new
   * one is live.
   */
  async publish(
    id: string,
    dto: PublishRichMenuTemplateDto,
  ): Promise<RichMenuTemplateView> {
    const template = await this.findOrThrow(id);

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
          where: { id: { not: id }, isDefault: true },
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
  async setDefault(id: string): Promise<RichMenuTemplateView> {
    const template = await this.findPublishedOrThrow(id);

    await this.lineClient.setDefault(template.lineRichMenuId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.richMenuTemplate.updateMany({
        where: { id: { not: id }, isDefault: true },
        data: { isDefault: false },
      });

      return tx.richMenuTemplate.update({
        where: { id },
        data: { isDefault: true },
      });
    });

    return this.toView(updated);
  }

  async clearDefault(): Promise<{ cleared: boolean }> {
    await this.lineClient.clearDefault();

    await this.prisma.richMenuTemplate.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });

    return { cleared: true };
  }

  /** Per-user menus win over the default, so each user can see a different one. */
  async linkUsers(
    id: string,
    dto: LinkRichMenuUsersDto,
  ): Promise<{ richMenuId: string; linked: number }> {
    const template = await this.findPublishedOrThrow(id);

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
    dto: LinkRichMenuUsersDto,
  ): Promise<{ unlinked: number }> {
    if (dto.lineUserIds.length === 1) {
      await this.lineClient.unlinkUser(dto.lineUserIds[0]);
    } else {
      await this.lineClient.bulkUnlink(dto.lineUserIds);
    }

    return { unlinked: dto.lineUserIds.length };
  }

  async getUserMenu(lineUserId: string): Promise<{
    lineUserId: string;
    richMenuId: string | null;
    template: RichMenuTemplateView | null;
  }> {
    const richMenuId = await this.lineClient.getUserMenu(lineUserId);

    if (!richMenuId) {
      return { lineUserId, richMenuId: null, template: null };
    }

    const template = await this.prisma.richMenuTemplate.findUnique({
      where: { lineRichMenuId: richMenuId },
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
  async listOnLine() {
    const [menus, defaultRichMenuId, templates, aliases] = await Promise.all([
      this.lineClient.list(),
      this.lineClient.getDefault(),
      this.prisma.richMenuTemplate.findMany({
        where: { lineRichMenuId: { not: null } },
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
    richMenuId: string,
  ): Promise<{ richMenuId: string; deleted: boolean }> {
    const owner = await this.prisma.richMenuTemplate.findUnique({
      where: { lineRichMenuId: richMenuId },
      select: { id: true },
    });

    if (owner) {
      throw new ConflictException(
        `Rich menu ${richMenuId} belongs to template ${owner.id}; delete the template instead`,
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
  async stats(id: string, query: RichMenuStatsQueryDto) {
    const template = await this.findOrThrow(id);
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
  async validate(id: string): Promise<{ valid: true }> {
    const template = await this.findOrThrow(id);
    await this.lineClient.validate(this.toLinePayload(template));

    return { valid: true };
  }

  private async findOrThrow(id: string): Promise<RichMenuTemplate> {
    const template = await this.prisma.richMenuTemplate.findUnique({
      where: { id },
    });

    if (!template) {
      throw new NotFoundException(`Rich menu template ${id} not found`);
    }

    return template;
  }

  private async findPublishedOrThrow(
    id: string,
  ): Promise<RichMenuTemplate & { lineRichMenuId: string }> {
    const template = await this.findOrThrow(id);

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
      linePayload: this.toLinePayload(template),
    };
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
