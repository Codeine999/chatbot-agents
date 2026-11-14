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

  find(userId: string): ChannelHandoffHandler | undefined {
    return this.handlers.find((handler) =>
      userId.startsWith(handler.userIdPrefix),
    );
  }
}
