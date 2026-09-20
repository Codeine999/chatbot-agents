/** LINE hosts rich menu JSON and binary content on two different domains. */
export const LINE_API_BASE_URL = 'https://api.line.me';
export const LINE_DATA_API_BASE_URL = 'https://api-data.line.me';

/**
 * The only `size` values LINE accepts for a rich menu. Anything else is
 * rejected at create time, so it is cheaper to refuse it in validation.
 */
export const RICH_MENU_SIZES = [
  { width: 2500, height: 1686 },
  { width: 2500, height: 843 },
  { width: 1200, height: 810 },
  { width: 1200, height: 405 },
  { width: 800, height: 540 },
  { width: 800, height: 270 },
] as const;

export const RICH_MENU_MAX_AREAS = 20;

/** LINE caps the rich menu image at 1MB, JPEG or PNG only. */
export const RICH_MENU_IMAGE_MAX_BYTES = 1024 * 1024;

export const RICH_MENU_IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

export const RICH_MENU_IMAGE_ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
] as const;

export const RICH_MENU_UPLOAD_URL_PREFIX = '/uploads/richmenu';

/** LINE rejects a bulk link/unlink request carrying more than 500 user ids. */
export const RICH_MENU_BULK_MAX_USERS = 500;

/** LINE rejects a text message longer than this, so a reply cannot exceed it. */
export const RICH_MENU_REPLY_TEXT_MAX = 5000;

/**
 * Cell counts a tenant can build a menu from. Each entry is a grid over the
 * full canvas, and every cell takes one uploaded image.
 */
export const RICH_MENU_CELL_LAYOUTS = [
  { cells: 1, columns: 1, rows: 1 },
  { cells: 2, columns: 2, rows: 1 },
  { cells: 3, columns: 3, rows: 1 },
  { cells: 4, columns: 2, rows: 2 },
  { cells: 6, columns: 3, rows: 2 },
] as const;

export type RichMenuCellLayout = (typeof RICH_MENU_CELL_LAYOUTS)[number];

export const RICH_MENU_CELL_UPLOAD_URL_PREFIX = '/uploads/richmenu/cells';
