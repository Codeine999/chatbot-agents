import type { PrismaService } from '../../../prisma/prisma.service';
import type { LineAdminService } from './admin/line-admin.service';

/**
 * Finds the LINE member for a LINE user id, or creates it from the LINE
 * profile on first contact. Takes its collaborators as arguments so the
 * adapter keeps owning the injected Prisma client and LINE API service.
 */
export async function findOrCreateLineMember(
  prisma: PrismaService,
  lineAdminService: Pick<LineAdminService, 'getProfile'>,
  lineUserId: string,
  /**
   * Runs once when this call created the member (not when it already
   * existed). Fire-and-forget: it must not throw or delay the webhook.
   */
  onCreated?: (member: { id: string; displayName: string }) => void,
) {
  const existingMember = await prisma.lineMember.findUnique({
    where: {
      lineUserId,
    },
  });

  if (existingMember) {
    return existingMember;
  }

  const profile = await lineAdminService.getProfile(lineUserId);
  const syncedAt = new Date();

  const member = await prisma.lineMember.upsert({
    where: {
      lineUserId,
    },
    create: {
      lineUserId,
      displayName: profile.displayName || lineUserId,
      pictureUrl: profile.pictureUrl,
      statusMessage: profile.statusMessage,
      profileSyncedAt: syncedAt,
    },
    update: {
      displayName: profile.displayName || lineUserId,
      pictureUrl: profile.pictureUrl,
      statusMessage: profile.statusMessage,
      profileSyncedAt: syncedAt,
    },
  });

  onCreated?.(member);
  return member;
}
