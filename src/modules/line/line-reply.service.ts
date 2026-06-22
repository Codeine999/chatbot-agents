import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type LineProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
};

@Injectable()
export class LineService {
  constructor(private readonly configService: ConfigService) {}

  private getAccessToken(): string {
    return this.configService.getOrThrow<string>('LINE_CHANNEL_ACCESS_TOKEN');
  }

  
  async getProfile(lineUserId: string): Promise<LineProfile> {
    const accessToken = this.getAccessToken();

    const response = await fetch(
      `https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('LINE profile error:', errorText);
      throw new InternalServerErrorException('Failed to get LINE profile');
    }

    return response.json() as Promise<LineProfile>;
  }

  async replyText(replyToken: string, text: string): Promise<void> {
    const accessToken = this.getAccessToken();

    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: 'text',
            text,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('LINE reply error:', errorText);
      throw new InternalServerErrorException('Failed to reply LINE message');
    }
  }

  async pushText(lineUserId: string, text: string): Promise<void> {
    const accessToken = this.getAccessToken();

    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [
          {
            type: 'text',
            text,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('LINE push error:', errorText);
      throw new InternalServerErrorException('Failed to push LINE message');
    }
  }

}
