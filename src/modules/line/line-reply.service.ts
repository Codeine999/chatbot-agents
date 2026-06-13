import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LineService {
  constructor(private readonly configService: ConfigService) {}

  async replyText(replyToken: string, text: string): Promise<void> {
    const accessToken = this.configService.getOrThrow<string>(
      'LINE_CHANNEL_ACCESS_TOKEN',
    );

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
}
