import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LINE_API_BASE_URL,
  LINE_DATA_API_BASE_URL,
} from './rich-menu.constants';
import type { RichMenuArea } from './dto/rich-menu.dto';

/** Exactly the body LINE expects at `POST /v2/bot/richmenu`. */
export type LineRichMenuPayload = {
  size: { width: number; height: number };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: RichMenuArea[];
};

export type LineRichMenuResponse = LineRichMenuPayload & {
  richMenuId: string;
};

export type LineRichMenuAlias = {
  richMenuAliasId: string;
  richMenuId: string;
};

/**
 * Thin transport for the LINE rich menu endpoints. It owns the channel token,
 * the two base URLs, and the error translation — nothing else. Orchestration
 * (what to publish, in which order) lives in `RichMenuService`.
 */
@Injectable()
export class LineRichMenuClient {
  private readonly logger = new Logger(LineRichMenuClient.name);
  private readonly httpTimeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.httpTimeoutMs = Number(
      configService.get('LINE_HTTP_TIMEOUT_MS') ?? 8_000,
    );
  }

  /** Ask LINE to check a menu without creating it. */
  async validate(payload: LineRichMenuPayload): Promise<void> {
    await this.request('POST', '/v2/bot/richmenu/validate', {
      body: payload,
    });
  }

  async create(payload: LineRichMenuPayload): Promise<string> {
    const created = await this.request<{ richMenuId: string }>(
      'POST',
      '/v2/bot/richmenu',
      { body: payload },
    );

    return created.richMenuId;
  }

  async get(richMenuId: string): Promise<LineRichMenuResponse> {
    return this.request<LineRichMenuResponse>(
      'GET',
      `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`,
    );
  }

  /** Every rich menu that currently exists on the LINE channel. */
  async list(): Promise<LineRichMenuResponse[]> {
    const response = await this.request<{
      richmenus?: LineRichMenuResponse[];
    }>('GET', '/v2/bot/richmenu/list');

    return response.richmenus ?? [];
  }

  async remove(richMenuId: string): Promise<void> {
    await this.request('DELETE', `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`);
  }

  /** The image is a separate upload on the data domain, not part of the JSON. */
  async uploadImage(
    richMenuId: string,
    image: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.request(
      'POST',
      `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`,
      {
        baseUrl: LINE_DATA_API_BASE_URL,
        body: image,
        contentType,
      },
    );
  }

  async downloadImage(
    richMenuId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const response = await this.send(
      'GET',
      `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`,
      { baseUrl: LINE_DATA_API_BASE_URL },
    );

    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      buffer,
      contentType: response.headers.get('content-type') ?? 'image/png',
    };
  }

  /** Make this menu the one every user sees. */
  async setDefault(richMenuId: string): Promise<void> {
    await this.request(
      'POST',
      `/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`,
    );
  }

  /** `null` when no default menu is set on the channel. */
  async getDefault(): Promise<string | null> {
    const response = await this.request<{ richMenuId: string }>(
      'GET',
      '/v2/bot/user/all/richmenu',
      { notFoundAsNull: true },
    );

    return response?.richMenuId ?? null;
  }

  async clearDefault(): Promise<void> {
    await this.request('DELETE', '/v2/bot/user/all/richmenu');
  }

  async linkUser(lineUserId: string, richMenuId: string): Promise<void> {
    await this.request(
      'POST',
      `/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu/${encodeURIComponent(richMenuId)}`,
    );
  }

  async unlinkUser(lineUserId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu`,
    );
  }

  /** The per-user menu, or `null` when the user falls back to the default. */
  async getUserMenu(lineUserId: string): Promise<string | null> {
    const response = await this.request<{ richMenuId: string }>(
      'GET',
      `/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu`,
      { notFoundAsNull: true },
    );

    return response?.richMenuId ?? null;
  }

  async bulkLink(lineUserIds: string[], richMenuId: string): Promise<void> {
    await this.request('POST', '/v2/bot/richmenu/bulk/link', {
      body: { richMenuId, userIds: lineUserIds },
    });
  }

  async bulkUnlink(lineUserIds: string[]): Promise<void> {
    await this.request('POST', '/v2/bot/richmenu/bulk/unlink', {
      body: { userIds: lineUserIds },
    });
  }

  async listAliases(): Promise<LineRichMenuAlias[]> {
    const response = await this.request<{ aliases?: LineRichMenuAlias[] }>(
      'GET',
      '/v2/bot/richmenu/alias/list',
    );

    return response.aliases ?? [];
  }

  async createAlias(
    richMenuAliasId: string,
    richMenuId: string,
  ): Promise<void> {
    await this.request('POST', '/v2/bot/richmenu/alias', {
      body: { richMenuAliasId, richMenuId },
    });
  }

  async updateAlias(
    richMenuAliasId: string,
    richMenuId: string,
  ): Promise<void> {
    await this.request(
      'POST',
      `/v2/bot/richmenu/alias/${encodeURIComponent(richMenuAliasId)}`,
      { body: { richMenuId } },
    );
  }

  async deleteAlias(richMenuAliasId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/v2/bot/richmenu/alias/${encodeURIComponent(richMenuAliasId)}`,
    );
  }

  /**
   * Points an alias at `richMenuId` whether or not it already exists, so a
   * republish does not have to know the previous state.
   */
  async upsertAlias(
    richMenuAliasId: string,
    richMenuId: string,
  ): Promise<void> {
    try {
      await this.createAlias(richMenuAliasId, richMenuId);
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      await this.updateAlias(richMenuAliasId, richMenuId);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      contentType?: string;
      baseUrl?: string;
      notFoundAsNull?: boolean;
    } = {},
  ): Promise<T> {
    const response = await this.send(method, path, options);

    if (response.status === 404 && options.notFoundAsNull) {
      return null as T;
    }

    const text = await response.text();
    if (!text) return undefined as T;

    return JSON.parse(text) as T;
  }

  private async send(
    method: string,
    path: string,
    options: {
      body?: unknown;
      contentType?: string;
      baseUrl?: string;
      notFoundAsNull?: boolean;
    },
  ): Promise<Response> {
    const baseUrl = options.baseUrl ?? LINE_API_BASE_URL;
    const isBinary = Buffer.isBuffer(options.body);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.getAccessToken()}`,
    };

    if (options.body !== undefined) {
      headers['Content-Type'] =
        options.contentType ?? (isBinary ? 'application/octet-stream' : 'application/json');
    }

    let response: Response;

    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        // `fetch` types accept an ArrayBuffer-backed view, not a Node Buffer.
        body:
          options.body === undefined
            ? undefined
            : isBinary
              ? new Uint8Array(options.body as Buffer)
              : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.httpTimeoutMs),
      });
    } catch (error) {
      this.logger.error(`LINE rich menu ${method} ${path} failed: ${String(error)}`);
      throw new BadGatewayException('LINE rich menu API is unreachable');
    }

    if (response.ok) return response;
    if (response.status === 404 && options.notFoundAsNull) return response;

    const errorText = await response.text();
    this.logger.error(
      `LINE rich menu ${method} ${path} -> ${response.status}: ${errorText.slice(0, 500)}`,
    );

    const message = this.describe(errorText, response.status);

    if (response.status === 404) throw new NotFoundException(message);
    if (response.status >= 500) throw new BadGatewayException(message);

    throw new BadRequestException(message);
  }

  /** Surfaces LINE's own per-field complaints instead of a bare status code. */
  private describe(errorText: string, status: number): string {
    try {
      const parsed = JSON.parse(errorText) as {
        message?: string;
        details?: { message?: string; property?: string }[];
      };

      const details = (parsed.details ?? [])
        .map((detail) =>
          [detail.property, detail.message].filter(Boolean).join(': '),
        )
        .filter(Boolean)
        .join('; ');

      const message = [parsed.message, details].filter(Boolean).join(' — ');

      if (message) return `LINE rich menu API: ${message}`;
    } catch {
      // Fall through to the raw body below.
    }

    return `LINE rich menu API returned ${status}: ${errorText.slice(0, 300)}`;
  }

  private getAccessToken(): string {
    return this.configService.getOrThrow<string>('LINE_CHANNEL_ACCESS_TOKEN');
  }
}
