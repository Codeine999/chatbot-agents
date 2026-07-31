import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as public for authentication integrations that honor this
 * metadata. Admin routes use the explicit @AdminGuard() decorator.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
