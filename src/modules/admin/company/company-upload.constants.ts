export const COMPANY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const COMPANY_IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export const COMPANY_IMAGE_ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
] as const;

export const COMPANY_UPLOAD_URL_PREFIX = '/uploads/company';
