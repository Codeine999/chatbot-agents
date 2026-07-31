import { AdminRole } from '../../../shared/guards/admin-auth.types';
import { AiProviderName } from '../../../ai-provider/types/ai-provider.types';

const ALL_PROVIDERS: readonly AiProviderName[] = [
  'GEMINI',
  'OPENAI',
  'ANTHROPIC',
];

const ALLOWED_PROVIDERS_BY_ROLE: Readonly<
  Record<AdminRole, readonly AiProviderName[]>
> = {
  admin: ['GEMINI'],
  owner: ALL_PROVIDERS,
  dev: ALL_PROVIDERS,
};

export function allowedProvidersForAdminRole(
  role: AdminRole,
): readonly AiProviderName[] {
  return ALLOWED_PROVIDERS_BY_ROLE[role];
}
