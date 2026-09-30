export const BILL_SLIP_MAX_BYTES = 5 * 1024 * 1024;

export const BILL_SLIP_MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export const BILL_SLIP_ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
] as const;

/** Storage folder for payment slips; legacy rows live at `/uploads/billing/`. */
export const BILL_SLIP_UPLOAD_FOLDER = 'billing';
