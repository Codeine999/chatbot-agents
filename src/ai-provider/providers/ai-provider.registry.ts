import type { AiProviderAdapter } from './ai-provider.interface';

/** Nest injection token for every generation adapter registered at runtime. */
export const AI_PROVIDER_ADAPTERS = Symbol('AI_PROVIDER_ADAPTERS');

export type AiProviderAdapterRegistry = readonly AiProviderAdapter[];
