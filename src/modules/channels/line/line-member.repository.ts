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

  return prisma.lineMember.upsert({
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
}
