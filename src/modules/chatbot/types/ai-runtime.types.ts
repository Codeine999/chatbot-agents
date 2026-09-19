import type {
  AiResponseStyle,
  AiSkill,
} from '../../ai/ai-setting/ai-setting-config';

export type AiRuntimeSetting = {
  systemPrompt: string;
  ownerPrompt?: string;
  tone?: string;
  skills: AiSkill[];
  responseStyle: AiResponseStyle;
  promptVersion: number;
  fallbackMessage: string;
};
