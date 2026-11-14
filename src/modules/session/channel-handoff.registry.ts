import { Injectable } from '@nestjs/common';

export type AdminRequestResult = 'REQUESTED' | 'ALREADY_WAITING' | 'NO_ROOM';

export interface ChannelHandoffHandler {
  readonly userIdPrefix: string;
  requestAdmin(userId: string): Promise<AdminRequestResult>;
}

@Injectable()
export class ChannelHandoffRegistry {
  private readonly handlers: ChannelHandoffHandler[] = [];

  register(handler: ChannelHandoffHandler): void {
    if (!this.handlers.includes(handler)) this.handlers.push(handler);
  }

  /**
   * The handler whose prefix matches the user id; the longest prefix wins, so
   * a channel with an empty prefix (LINE) only gets ids nobody else claims.
   */
  find(userId: string): ChannelHandoffHandler | undefined {
    return this.handlers
      .filter((handler) => userId.startsWith(handler.userIdPrefix))
      .sort((a, b) => b.userIdPrefix.length - a.userIdPrefix.length)[0];
  }
}
