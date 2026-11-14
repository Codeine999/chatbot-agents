import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppAbuseService } from '../app-abuse.service';
import { AppApiException } from '../app-errors';
import { AppMessageConfig } from '../app-message.config';
import type { AppRequest } from '../app-request';
import { clientIpHash } from '../client-ip';

/**
 * First gate of every public App Message route:
 * feature off → 404, banned IP → 429, browser from a foreign site → 403.
 */
@Injectable()
export class AppClientGuard implements CanActivate {
  constructor(
    private readonly config: AppMessageConfig,
    private readonly abuse: AppAbuseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.values.enabled) throw new NotFoundException();

    const request = context.switchToHttp().getRequest<AppRequest>();
    const ipHash = clientIpHash(request.ip, this.config.values.ipHashSalt);
    await this.abuse.assertIpAllowed(ipHash);

    // Browsers always send Origin, so this stops other websites from using
    // the API through their visitors. Apps and servers send none.
    const origin = request.headers.origin;
    if (
      origin !== undefined &&
      !this.config.values.allowedOrigins.includes(origin.toLowerCase())
    ) {
      throw new AppApiException(
        403,
        'APP_ORIGIN_NOT_ALLOWED',
        'Origin is not allowed',
      );
    }

    request.appCaller = { ipHash };
    return true;
  }
}
