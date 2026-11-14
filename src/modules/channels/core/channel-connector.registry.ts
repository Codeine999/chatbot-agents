import { Injectable } from '@nestjs/common';
import type { StoredChannelKind } from '../../../shared/channel/channel-kinds';
import type { ChannelConnector } from './channel-connector';

/**
 * Connectors register themselves in `onModuleInit` (like
 * ChannelHandoffRegistry), so plugging a platform in is importing its module.
 * A channel without a connector (APP) has no webhook and nothing to send.
 */
@Injectable()
export class ChannelConnectorRegistry {
  private readonly connectors = new Map<StoredChannelKind, ChannelConnector>();

  register(connector: ChannelConnector): void {
    if (this.connectors.has(connector.kind))
      throw new Error(`Duplicate channel connector: ${connector.kind}`);
    this.connectors.set(connector.kind, connector);
  }

  find(kind: StoredChannelKind): ChannelConnector | undefined {
    return this.connectors.get(kind);
  }

  /** The connector behind a webhook URL; disabled ones are treated as absent. */
  findEnabled(kind: string): ChannelConnector | undefined {
    const connector = this.connectors.get(kind.toUpperCase() as never);
    return connector?.enabled ? connector : undefined;
  }
}
