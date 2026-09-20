import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type RichMenuReply } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RichMenuReplyCacheService } from '../../chatbot/menu/rich-menu-reply-cache.service';
import {
  encodeMenuReplyPostback,
  MENU_POSTBACK_REPLY_PREFIX,
} from '../../../shared/richMenu/menu-postback';
import type {
  CreateRichMenuReplyDto,
  ListRichMenuReplyQueryDto,
  UpdateRichMenuReplyDto,
} from './dto/rich-menu-reply.dto';

export type RichMenuReplyView = RichMenuReply & {
  /** Paste-ready value for a rich menu area's postback `data`. */
  postbackData: string;
  /** Published menus whose buttons currently point at this reply. */
  usedByTemplates: { id: string; name: string; status: string }[];
};

/**
 * The answers a tenant writes for its own rich menu buttons.
 *
 * A menu on LINE is immutable and keeps working on customers' phones after it
 * is replaced here, so the button carries only `menu=<key>` and the wording
 * lives in this table. Editing an answer therefore never republishes a menu,
 * and deleting one leaves live buttons pointing at nothing — which is why
 * `remove` refuses while a template still references the key.
 */
@Injectable()
export class RichMenuReplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RichMenuReplyCacheService,
  ) {}

  async list(
    tenantId: string | null,
    query: ListRichMenuReplyQueryDto = {} as ListRichMenuReplyQueryDto,
  ): Promise<RichMenuReplyView[]> {
    const replies = await this.prisma.richMenuReply.findMany({
      where: {
        tenantId,
        ...(query.active === undefined
          ? {}
          : { active: query.active === 'true' }),
        ...(query.search
          ? {
              OR: [
                { key: { contains: query.search, mode: 'insensitive' } },
                { label: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const usage = await this.usageByKey(
      tenantId,
      replies.map((reply) => reply.key),
    );

    return replies.map((reply) => this.toView(reply, usage.get(reply.key)));
  }

  async get(tenantId: string | null, id: string): Promise<RichMenuReplyView> {
    const reply = await this.findOrThrow(tenantId, id);
    const usage = await this.usageByKey(tenantId, [reply.key]);

    return this.toView(reply, usage.get(reply.key));
  }

  async create(
    tenantId: string | null,
    dto: CreateRichMenuReplyDto,
    adminId?: string,
  ): Promise<RichMenuReplyView> {
    try {
      const reply = await this.prisma.richMenuReply.create({
        data: {
          tenantId,
          key: dto.key,
          label: dto.label,
          replyText: dto.replyText,
          active: dto.active,
          sortOrder: dto.sortOrder,
          createdByAdminId: adminId ?? null,
        },
      });

      await this.reloadBot();

      return this.toView(reply, []);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `Rich menu reply key "${dto.key}" is already used`,
        );
      }

      throw error;
    }
  }

  async update(
    tenantId: string | null,
    id: string,
    dto: UpdateRichMenuReplyDto,
  ): Promise<RichMenuReplyView> {
    const existing = await this.findOrThrow(tenantId, id);

    const reply = await this.prisma.richMenuReply.update({
      where: { id: existing.id },
      data: {
        label: dto.label,
        replyText: dto.replyText,
        active: dto.active,
        sortOrder: dto.sortOrder,
      },
    });

    await this.reloadBot();

    const usage = await this.usageByKey(tenantId, [reply.key]);

    return this.toView(reply, usage.get(reply.key));
  }

  /**
   * Refuses while any template still carries a button for this key, published
   * or not: those buttons are already on customers' phones and would answer
   * with nothing.
   */
  async remove(
    tenantId: string | null,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const reply = await this.findOrThrow(tenantId, id);
    const usage = await this.usageByKey(tenantId, [reply.key]);
    const users = usage.get(reply.key) ?? [];

    if (users.length) {
      throw new ConflictException(
        `Rich menu reply "${reply.key}" is still used by ${users
          .map((template) => template.name)
          .join(', ')}. Remove the button or deactivate the reply instead.`,
      );
    }

    await this.prisma.richMenuReply.delete({ where: { id: reply.id } });
    await this.reloadBot();

    return { id: reply.id, deleted: true };
  }

  /**
   * Pulls the bot's in-memory copy forward immediately.
   *
   * Without it a tenant who adds a button, publishes it and taps it to check
   * gets the AI answer for up to a cache TTL, and reasonably concludes the
   * feature is broken. A failed reload is not worth failing the write over:
   * the periodic refresh still catches up on its own.
   */
  private async reloadBot(): Promise<void> {
    await this.cache.refresh({ force: true }).catch(() => undefined);
  }

  private async findOrThrow(
    tenantId: string | null,
    id: string,
  ): Promise<RichMenuReply> {
    const reply = await this.prisma.richMenuReply.findFirst({
      where: { id, tenantId },
    });

    if (!reply) {
      throw new NotFoundException(`Rich menu reply ${id} not found`);
    }

    return reply;
  }

  /**
   * Which templates reference each key, found by matching the postback value
   * inside the `areas` JSON rather than by keeping a second table in step.
   */
  private async usageByKey(
    tenantId: string | null,
    keys: string[],
  ): Promise<Map<string, RichMenuReplyView['usedByTemplates']>> {
    const usage = new Map<string, RichMenuReplyView['usedByTemplates']>();
    if (!keys.length) return usage;

    const templates = await this.prisma.richMenuTemplate.findMany({
      where: { tenantId },
      select: { id: true, name: true, status: true, areas: true },
    });

    for (const template of templates) {
      for (const key of this.referencedKeys(template.areas)) {
        if (!keys.includes(key)) continue;

        const list = usage.get(key) ?? [];
        list.push({
          id: template.id,
          name: template.name,
          status: template.status,
        });
        usage.set(key, list);
      }
    }

    return usage;
  }

  /** Reads `menu=<key>` out of an `areas` JSON value without trusting its shape. */
  private referencedKeys(areas: Prisma.JsonValue): string[] {
    if (!Array.isArray(areas)) return [];

    const keys: string[] = [];

    for (const area of areas) {
      const action = (area as { action?: { data?: unknown } })?.action;
      const data = action?.data;

      if (
        typeof data === 'string' &&
        data.startsWith(MENU_POSTBACK_REPLY_PREFIX)
      ) {
        keys.push(data.slice(MENU_POSTBACK_REPLY_PREFIX.length));
      }
    }

    return keys;
  }

  private toView(
    reply: RichMenuReply,
    usedByTemplates: RichMenuReplyView['usedByTemplates'] = [],
  ): RichMenuReplyView {
    return {
      ...reply,
      postbackData: encodeMenuReplyPostback(reply.key),
      usedByTemplates,
    };
  }
}
