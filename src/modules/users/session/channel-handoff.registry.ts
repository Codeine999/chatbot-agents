import { Injectable } from '@nestjs/common';

/**
 * Lets a channel other than LINE answer "the customer asked for an admin".
 * UserSessionService.requestAdmin looks the conversation up in LINE tables,
 * which would silently do nothing for another channel's users. Their ids carry
 * a channel prefix (`app:`), so the owning module registers a handler for it.
 */
export interface ChannelHandoffHandler {
  /** Prefix of the userIds this handler owns, e.g. 'app:'. */
  readonly userIdPrefix: string;
  requestAdmin(userId: string): Promise<void>;
}

@Injectable()
export class ChannelHandoffRegistry {
  private readonly handlers: ChannelHandoffHandler[] = [];

  register(handler: ChannelHandoffHandler): void {
    if (!this.handlers.includes(handler)) this.handlers.push(handler);
  }

  find(userId: string): ChannelHandoffHandler | undefined {
    return this.handlers.find((handler) =>
      userId.startsWith(handler.userIdPrefix),
    );
  }
}
