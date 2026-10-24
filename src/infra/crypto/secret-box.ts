import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Never carries the plaintext or the key in its message. */
export class SecretBoxError extends Error {}

/** Decodes a base64 AES-256 key, e.g. from `openssl rand -base64 32`. */
export function parseSecretKey(base64: string | undefined): Buffer {
  if (!base64?.trim())
    throw new SecretBoxError('Credential encryption key is not configured');
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== KEY_BYTES)
    throw new SecretBoxError('Credential encryption key must be 32 bytes');
  return key;
}

/** Encrypts to base64(iv | auth tag | ciphertext) with a fresh random IV. */
export function sealSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    'base64',
  );
}

/** Rejects a wrong key or any tampered byte through the GCM auth tag. */
export function openSecret(sealed: string, key: Buffer): string {
  try {
    const bytes = Buffer.from(sealed, 'base64');
    if (bytes.length <= IV_BYTES + TAG_BYTES) throw new Error('short');
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      bytes.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretBoxError('Stored credential could not be decrypted');
  }
}
