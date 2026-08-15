import { stripJsonCodeFence } from '../../utils/json.utils';

export const IMAGE_ANALYSIS_CLASSIFICATIONS = [
  'SAFE_GENERAL',
  'TRANSACTION',
  'BUSINESS_UNVERIFIED',
  'UNREADABLE',
] as const;

export type ImageAnalysisClassification =
  (typeof IMAGE_ANALYSIS_CLASSIFICATIONS)[number];

export type ImageAnalysisResult = Readonly<{
  classification: ImageAnalysisClassification;
  answer: string;
}>;

const BLOCKED_ANSWER_PATTERNS = [
  /\b(?:payment|transaction|transfer|receipt|invoice|paid|bank|account|promptpay|qr|amount|phone)\b/iu,
  /สลิป|ใบเสร็จ|ใบกำกับภาษี|หลักฐานการ(?:โอน|ชำระ)|โอน(?:เงิน|สำเร็จ)|ชำระเงิน|ยอด(?:โอน|ชำระ|เงิน)|(?:เลข|หมายเลข)(?:ที่)?บัญชี|พร้อมเพย์|ธนาคาร|คิวอาร์|เบอร์โทร|โทรศัพท์/iu,
  /\b(?:price|stock|promotion|shipping|warranty|order status)\b/iu,
  /ราคา|โปรโมชัน|โปรโมชั่น|สต็อก|มีสินค้า|สินค้าหมด|ค่าจัดส่ง|รับประกัน|สถานะ(?:สมัคร|คำสั่งซื้อ|จัดส่ง|ชำระ)/iu,
  /\d[\d,.]*\s*บาท/iu,
] as const;

export function parseImageAnalysisResponse(
  rawText: string,
): ImageAnalysisResult | null {
  try {
    const parsed: unknown = JSON.parse(stripJsonCodeFence(rawText.trim()));
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.classification !== 'string' ||
      !IMAGE_ANALYSIS_CLASSIFICATIONS.includes(
        candidate.classification as ImageAnalysisClassification,
      ) ||
      typeof candidate.answer !== 'string'
    ) {
      return null;
    }

    return {
      classification:
        candidate.classification as ImageAnalysisClassification,
      answer: candidate.answer.trim().slice(0, 2_000),
    };
  } catch {
    return null;
  }
}

export function isSafeImageAnalysis(result: ImageAnalysisResult): boolean {
  return (
    result.classification === 'SAFE_GENERAL' &&
    result.answer.length > 0 &&
    !BLOCKED_ANSWER_PATTERNS.some((pattern) => pattern.test(result.answer))
  );
}
