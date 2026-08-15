export const ADMIN_PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const ADMIN_PROFILE_IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export const ADMIN_PROFILE_IMAGE_ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
] as const;

export const ADMIN_UPLOAD_URL_PREFIX = '/uploads/admin';
