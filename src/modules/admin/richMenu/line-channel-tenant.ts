import { ConfigService } from '@nestjs/config';

/**
 * Rich menus currently use the null scope and one deployment channel.
 * LINE_CHANNEL_TENANT_ID is intentionally inactive until tenancy is enabled.
 */
export function lineChannelTenantId(_config: ConfigService): string | null {
  void _config; // Retain constructor compatibility while the setting is inactive.
  return null;
}
