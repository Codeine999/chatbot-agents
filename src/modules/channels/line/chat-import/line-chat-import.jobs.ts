/** Jobs of the `line-chat-import` queue. Ids use `_` because BullMQ rejects `:` in custom ids. */
export const IMPORT_JOB = {
  syncFollowers: 'sync-followers',
  parse: 'parse',
  match: 'match',
  materialize: 'materialize',
  materializeThread: 'materialize-thread',
  linkNewMember: 'link-new-member',
  deleteBatch: 'delete-batch',
} as const;

export type ImportJobName = (typeof IMPORT_JOB)[keyof typeof IMPORT_JOB];

export type BatchJobData = { batchId: string; chunk: number };
export type ThreadJobData = { threadId: string };
export type MemberJobData = { lineMemberId: string };

export const IMPORT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

export function batchJobId(
  name: ImportJobName,
  batchId: string,
  chunk: number,
): string {
  return `${name}_${batchId}_${chunk}`;
}
