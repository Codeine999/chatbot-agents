import { ConfigService } from '@nestjs/config';

/** Registration is an explicit opt-in feature. Environment values arrive as
 * strings, while tests or custom loaders may provide a boolean. */
export function isRegistrationEnabled(config: ConfigService): boolean {
  const value = config.get<unknown>('CAN_REGISTER');

  return (
    value === true ||
    (typeof value === 'string' && value.trim().toLowerCase() === 'true')
  );
}
