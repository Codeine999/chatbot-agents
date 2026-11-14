import { z } from 'zod';

const KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,40}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_KEYS = 20;
const MAX_JSON_BYTES = 2048;

/**
 * Client-supplied extras: a flat object of short strings, numbers and
 * booleans. Stored and shown to admins, never put into a prompt.
 */
export const appMetadataSchema = z
  .record(
    z.string(),
    z.union([z.string().max(200), z.number().finite(), z.boolean()]),
  )
  .refine((value) => Object.keys(value).length <= MAX_KEYS, 'Too many keys')
  .refine(
    (value) =>
      Object.keys(value).every(
        (key) => KEY_PATTERN.test(key) && !FORBIDDEN_KEYS.has(key),
      ),
    'Invalid key',
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_JSON_BYTES,
    'Metadata too large',
  );

export type AppMetadata = z.infer<typeof appMetadataSchema>;
