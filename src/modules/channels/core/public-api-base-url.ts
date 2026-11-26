import type { ConfigService } from '@nestjs/config';

export const DEFAULT_PUBLIC_API_BASE_URL = 'https://api.keela-agent.online';

/** Public origin of this API, without a trailing slash; used to build webhook URLs. */
export function publicApiBaseUrl(config: ConfigService): string {
  const base = config.get<string>('PUBLIC_API_BASE_URL')?.trim();
  return (base || DEFAULT_PUBLIC_API_BASE_URL).replace(/\/+$/, '');
}
