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

/** Storage folder for profile pictures. */
export const ADMIN_UPLOAD_FOLDER = 'admin_profile_image';

/**
 * Folders a stored profile picture may be in: the current one, and `admin`,
 * where pictures uploaded before the rename live (`/uploads/admin/...`).
 */
export const ADMIN_UPLOAD_FOLDERS = [ADMIN_UPLOAD_FOLDER, 'admin'] as const;
