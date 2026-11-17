import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { FileStorageService } from '../../../../infra/storage/file-storage.service';
import type { AiProviderImage } from '../../../../ai-provider/types/ai-provider.types';
import { LineService } from '../delivery/line-reply.service';

/** Customer photos live here, private: on R2 they are only reachable by signed URL. */
export const LINE_IMAGE_FOLDER = 'line/images';

const EXTENSIONS: Record<AiProviderImage['mediaType'], string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Keeps a copy of each image a customer sends, so the admin inbox can show it
 * after LINE deletes the original. The reference goes into
 * `lineChatHistory.mediaUrl` of the customer's message.
 *
 * Never part of the turn: it runs after the message is stored, outside any
 * transaction, and a failure only leaves `mediaUrl` null (logged). The bot's
 * reply never waits for it and never fails because of it.
 */
@Injectable()
export class LineImageArchiveService {
  private readonly logger = new Logger(LineImageArchiveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorageService,
    private readonly line: LineService,
  ) {}

  /** Downloads a customer photo from LINE and stores it. Returns immediately. */
  fetchAndKeep(lineMessageId: string): void {
    void this.store(lineMessageId, () =>
      this.line.getImageContent(lineMessageId),
    ).catch((error: unknown) => this.warn(lineMessageId, error));
  }

  /** Awaitable form of `fetchAndKeep`. */
  async store(
    lineMessageId: string,
    load: () => Promise<AiProviderImage>,
  ): Promise<string | null> {
    const row = await this.prisma.lineChatHistory.findUnique({
      where: { lineMessageId },
      select: { id: true, mediaUrl: true },
    });
    // A redelivered event finds the copy already stored.
    if (!row || row.mediaUrl) return row?.mediaUrl ?? null;

    const image = await load();
    const reference = await this.storage.upload({
      visibility: 'private',
      folder: LINE_IMAGE_FOLDER,
      body: Buffer.from(image.data, 'base64'),
      contentType: image.mediaType,
      extension: EXTENSIONS[image.mediaType],
    });

    // Two workers can race on one redelivered event; the first write wins and
    // the loser's file is removed instead of left orphaned.
    const saved = await this.prisma.lineChatHistory.updateMany({
      where: { id: row.id, mediaUrl: null },
      data: { mediaUrl: reference },
    });
    if (!saved.count) {
      await this.storage.remove(reference, LINE_IMAGE_FOLDER);
      return null;
    }
    return reference;
  }

  private warn(lineMessageId: string, error: unknown) {
    this.logger.warn(
      `LINE image ${lineMessageId} not archived: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
