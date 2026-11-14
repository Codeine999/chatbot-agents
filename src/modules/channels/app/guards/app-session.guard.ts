import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AppAbuseService } from '../app-abuse.service';
import { sessionInvalid } from '../app-errors';
import type { AppRequest } from '../app-request';
import { AppSessionService } from '../app-session.service';

/** Runs after AppClientGuard. A wrong token spends the IP's failure budget. */
@Injectable()
export class AppSessionGuard implements CanActivate {
  constructor(
    private readonly sessions: AppSessionService,
    private readonly abuse: AppAbuseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const caller = request.appCaller;
    if (!caller) throw sessionInvalid();

    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && /^Bearer /i.test(header)
        ? header.slice(7).trim()
        : '';
    const guest = token ? await this.sessions.authenticate(token) : null;
    if (!guest) {
      await this.abuse.recordInvalidAuth(caller.ipHash);
      throw sessionInvalid();
    }

    request.appGuest = { ...caller, ...guest };
    return true;
  }
}
