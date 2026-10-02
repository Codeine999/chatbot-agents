import type { KnowledgeItem } from '../types/chat.types';
import type { AiRuntimeSetting } from '../types/ai-runtime.types';

export type AiAnswerPromptInput = Readonly<{
  setting: AiRuntimeSetting;
  ragContext?: readonly KnowledgeItem[];
  modeRules: string;
}>;

const PROMPT_PRECEDENCE = `ลำดับอำนาจของคำสั่ง
1. systemPrompt และ modeRules เป็นกฎของแพลตฟอร์ม modeRules กำหนดรูปแบบผลลัพธ์ของคำขอนี้
2. ownerPrompt, tone, skill และ responseStyle ใช้กำหนดบุคลิกและรูปแบบเท่านั้น ห้ามขัดกฎแพลตฟอร์ม`;

export function composeAiAnswerPrompt(input: AiAnswerPromptInput): string {
  const { setting } = input;

  return [
    PROMPT_PRECEDENCE,
    section('systemPrompt', setting.systemPrompt),
    section('ownerPrompt', escapeUntrusted(setting.ownerPrompt ?? '')),
    section('tone', escapeUntrusted(setting.tone ?? '')),
    section('skill', formatSkills(setting.skills)),
    section('responseStyle', formatResponseStyle(setting.responseStyle)),
    // section('promptVersion', String(setting.promptVersion)),
    section('modeRules', input.modeRules),
    section('ragContext', safeJson(toRagContext(input.ragContext ?? []))),
  ].join('\n\n');
}

function formatSkills(skills: AiRuntimeSetting['skills']): string {
  return skills
    .map(
      (skill) =>
        `- ${escapeUntrusted(skill.name)}:\n  ${escapeUntrusted(skill.prompt).replace(/\n/g, '\n  ')}`,
    )
    .join('\n\n');
}

function formatResponseStyle(style: AiRuntimeSetting['responseStyle']): string {
  const length = {
    short:
      'ตอบสั้นเป็นหลัก 1–3 ประโยค ขยายได้เมื่อจำเป็นต้องรักษาเงื่อนไขสำคัญ',
    medium: 'ตอบพร้อมรายละเอียดที่จำเป็น แบ่งย่อหน้าเมื่อเปลี่ยนประเด็น',
    adaptive:
      'ปรับความยาวตามคำถาม คำถามสั้นตอบตรงประเด็น คำถามหลายส่วนตอบให้ครบ',
  };
  const emoji = {
    none: 'ไม่ใช้อีโมจิ',
    light: 'ใช้อีโมจิได้เล็กน้อยเมื่อเหมาะกับน้ำเสียง ไม่ต้องใส่ทุกคำตอบ',
    normal: 'ใช้อีโมจิเมื่อช่วยให้อ่านง่ายและเหมาะกับเรื่องที่คุย',
  };
  return `${length[style.targetLength]}\n${emoji[style.emojiLevel]}`;
}

function toRagContext(items: readonly KnowledgeItem[]) {
  return items.map((item) => ({
    ref: `${item.source}:${item.id}`,
    source: item.source,
    id: item.id,
    title: item.title ?? '',
    category: item.category ?? '',
    entityKey:
      typeof item.metadata?.entityKey === 'string'
        ? item.metadata.entityKey
        : '',
    topicKey:
      typeof item.metadata?.topicKey === 'string' ? item.metadata.topicKey : '',
    content: item.content ?? '',
    answer: item.answer ?? '',
  }));
}

function section(name: string, content: string): string {
  return `<${name}>\n${content}\n</${name}>`;
}

function safeJson(value: unknown): string {
  return escapeUntrusted(JSON.stringify(value, null, 2));
}

/** Prevent untrusted data from closing or opening prompt section tags. */
function escapeUntrusted(value: string): string {
  return value
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}
