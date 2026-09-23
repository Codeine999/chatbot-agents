import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RichMenuReply } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { lineChannelTenantId } from '../../admin/richMenu/line-channel-tenant';
import { parseMenuPostback } from '../../../shared/richMenu/menu-postback';

export type RichMenuReplyMatch = Readonly<{
  key: string;
  label: string;
  replyText: string;
  /** How the tap arrived: the button's own key, or the caption typed/echoed. */
  via: 'POSTBACK' | 'LABEL';
}>;

const MAX_CACHED_REPLIES = 200;

/**
 * The answers this channel's tenant wrote for its rich menu buttons, held in
 * memory so a tap costs no database round trip on the hot path.
 *
 * Two ways in, because a published menu outlives any change made here:
 * `byKey` for the `menu=<key>` a button carries, and `byLabel` for a customer
 * who typed the caption or whose tap echoed it into the chat as text.
 *
 * A miss is not an error. Buttons stay on customers' phones after their reply
 * is deleted or deactivated, and the router simply carries on with normal
 * routing rather than answering with nothing.
 */
@Injectable()
export class RichMenuReplyCacheService implements OnModuleInit {
  private readonly logger = new Logger(RichMenuReplyCacheService.name);
  private readonly tenantId: string | null;

  private byKeyIndex = new Map<string, RichMenuReply>();
  private byLabelIndex = new Map<string, RichMenuReply>();
  /** In-flight refresh; concurrent callers await it instead of re-querying. */
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.tenantId = lineChannelTenantId(config);
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  byKey(key: string): RichMenuReplyMatch | null {
    return this.toMatch(this.byKeyIndex.get(key), 'POSTBACK');
  }

  /** Captions in the tenant's own order, for prompting a customer with them. */
  labels(): string[] {
    return [...this.byKeyIndex.values()].map((reply) => reply.label);
  }

  /** Resolves a raw `postback.data` value, ignoring the grammars it is not. */
  byPostbackData(data: string): RichMenuReplyMatch | null {
    const parsed = parseMenuPostback(data);

    return parsed?.kind === 'reply' ? this.byKey(parsed.key) : null;
  }

  /** Exact, case-insensitive caption match; never a fuzzy or partial one. */
  byLabel(text: string): RichMenuReplyMatch | null {
    const normalized = this.normalizeLabel(text);
    if (!normalized) return null;

    return this.toMatch(this.byLabelIndex.get(normalized), 'LABEL');
  }

  /**
   * Reloads the snapshot from the database.
   *
   * A plain call joins a refresh that is already running. `force` is for a
   * caller that has just written: joining
   * an in-flight read would settle on a snapshot taken before that write
   * committed, so the caller would be told the bot is up to date when it is
   * serving the previous wording. A forced refresh therefore queues behind
   * whatever is running and reads again.
   */
  refresh(options: { force?: boolean } = {}): Promise<void> {
    if (this.refreshing && !options.force) return this.refreshing;

    const started = (this.refreshing ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.doRefresh());

    this.refreshing = started;

    void started.finally(() => {
      // Only clear the slot if nothing newer has claimed it.
      if (this.refreshing === started) this.refreshing = null;
    });

    return started;
  }

  private async doRefresh(): Promise<void> {
    try {
      const rows = await this.prisma.richMenuReply.findMany({
        where: { tenantId: this.tenantId, active: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: MAX_CACHED_REPLIES,
      });

      const byKeyIndex = new Map<string, RichMenuReply>();
      const byLabelIndex = new Map<string, RichMenuReply>();

      for (const row of rows) {
        byKeyIndex.set(row.key, row);

        // Two buttons may legitimately share a caption; the first in the
        // tenant's own order wins, so the choice is theirs and it is stable.
        const label = this.normalizeLabel(row.label);
        if (label && !byLabelIndex.has(label)) byLabelIndex.set(label, row);
      }

      this.byKeyIndex = byKeyIndex;
      this.byLabelIndex = byLabelIndex;

      this.logger.debug(
        `[RichMenuReplyCache] loaded ${rows.length} active repl(ies)`,
      );
    } catch (error) {
      // Keep serving the previous snapshot; the next tick retries.
      this.logger.error(
        `[RichMenuReplyCache] refresh failed, keeping ${this.byKeyIndex.size} cached entries`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private normalizeLabel(value: string): string {
    return value.trim().toLocaleLowerCase();
  }

  private toMatch(
    reply: RichMenuReply | undefined,
    via: RichMenuReplyMatch['via'],
  ): RichMenuReplyMatch | null {
    if (!reply) return null;

    return {
      key: reply.key,
      label: reply.label,
      replyText: reply.replyText,
      via,
    };
  }
}
