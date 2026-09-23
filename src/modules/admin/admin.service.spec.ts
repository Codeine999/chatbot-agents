import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AdminRole,
  AuthenticatedAdmin,
} from '../../shared/guards/admin-auth.types';
import { AdminService } from './admin.service';

describe('AdminService.getAllAdmin', () => {
  const row = {
    id: 'a1',
    username: 'alice',
    firstname: 'Alice',
    lastname: 'Smith',
    email: 'alice@example.com',
    phone: '0800000000',
    image: null,
    role: 'admin',
    aiEnabled: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  };

  type FindManyArgs = {
    where: unknown;
    select: Record<string, unknown>;
  };

  const setup = () => {
    const findMany = jest
      .fn<Promise<unknown[]>, [FindManyArgs]>()
      .mockResolvedValue([row]);
    const prisma = { adminMember: { findMany } } as unknown as PrismaService;
    return { service: new AdminService(prisma), findMany };
  };

  it("scopes to the caller's company and never selects the password", async () => {
    const { service, findMany } = setup();

    const result = await service.getAllAdmin('company-1');

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ companyId: 'company-1' });
    expect(args.select.password).toBeUndefined();
    expect(result).toEqual([
      {
        id: 'a1',
        username: 'alice',
        firstName: 'Alice',
        lastName: 'Smith',
        email: 'alice@example.com',
        phone: '0800000000',
        image: null,
        role: 'admin',
        aiEnabled: true,
        createdAt: row.createdAt,
      },
    ]);
  });

  it('keeps a legacy admin inside the unscoped rows', async () => {
    const { service, findMany } = setup();

    await service.getAllAdmin(null);

    expect(findMany.mock.calls[0][0].where).toEqual({ companyId: null });
  });
});

describe('AdminService update/delete', () => {
  const actor = (
    role: AdminRole,
    overrides: Partial<AuthenticatedAdmin> = {},
  ): AuthenticatedAdmin => ({
    id: 'actor',
    username: 'actor',
    firstName: 'A',
    lastName: 'B',
    email: 'actor@example.com',
    phone: '0800000001',
    image: null,
    role,
    companyId: 'company-1',
    ...overrides,
  });

  type Target = { id: string; role: AdminRole; image: string | null };
  type FindFirstArgs = { where: { id: string; companyId: string | null } };
  type WriteArgs = { where: { id: string }; data?: Record<string, unknown> };

  const setup = (target: Target | null) => {
    const findFirst = jest
      .fn<Promise<Target | null>, [FindFirstArgs]>()
      .mockResolvedValue(target);
    const update = jest
      .fn<Promise<Record<string, unknown>>, [WriteArgs]>()
      .mockResolvedValue({ id: target?.id, firstname: 'F', lastname: 'L' });
    const remove = jest
      .fn<Promise<unknown>, [WriteArgs]>()
      .mockResolvedValue({});
    const prisma = {
      adminMember: { findFirst, update, delete: remove },
    } as unknown as PrismaService;
    return { service: new AdminService(prisma), findFirst, update, remove };
  };

  it("looks the target up inside the actor's company only", async () => {
    const { service, findFirst } = setup(null);

    await expect(
      service.updateAdmin(actor('dev'), 'other', { firstName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: 'other',
      companyId: 'company-1',
    });
  });

  it('lets an owner edit an admin but not another owner or a dev', async () => {
    const admin = setup({ id: 't', role: 'admin', image: null });
    await admin.service.updateAdmin(actor('owner'), 't', { firstName: 'X' });
    expect(admin.update).toHaveBeenCalled();

    for (const role of ['owner', 'dev'] as const) {
      const { service, update } = setup({ id: 't', role, image: null });
      await expect(
        service.updateAdmin(actor('owner'), 't', { firstName: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('blocks promotion to dev, owner-granted owner, and self role change', async () => {
    const devActor = setup({ id: 't', role: 'admin', image: null });
    await expect(
      devActor.service.updateAdmin(actor('dev'), 't', { role: 'dev' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const ownerActor = setup({ id: 't', role: 'admin', image: null });
    await expect(
      ownerActor.service.updateAdmin(actor('owner'), 't', { role: 'owner' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const self = setup({ id: 'actor', role: 'owner', image: null });
    await expect(
      self.service.updateAdmin(actor('owner'), 'actor', { role: 'admin' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await self.service.updateAdmin(actor('owner'), 'actor', {
      firstName: 'Me',
    });
    expect(self.update).toHaveBeenCalledTimes(1);
  });

  it('hashes a new password and never stores it in plain text', async () => {
    const { service, update } = setup({ id: 't', role: 'admin', image: null });

    await service.updateAdmin(actor('dev'), 't', { password: 'new-secret-1' });

    const stored = update.mock.calls[0][0].data?.password;
    expect(typeof stored).toBe('string');
    expect(stored).not.toBe('new-secret-1');
  });

  it('maps a duplicate username/email/phone to 409', async () => {
    const { service, update } = setup({ id: 't', role: 'admin', image: null });
    update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.updateAdmin(actor('dev'), 't', { email: 'dup@example.com' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to delete yourself or a peer owner', async () => {
    const self = setup({ id: 'actor', role: 'owner', image: null });
    await expect(
      self.service.deleteAdmin(actor('owner'), 'actor'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const peer = setup({ id: 't', role: 'owner', image: null });
    await expect(
      peer.service.deleteAdmin(actor('owner'), 't'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(peer.remove).not.toHaveBeenCalled();
  });

  it('deletes an admin, and turns a blocking top-up history into 409', async () => {
    const ok = setup({ id: 't', role: 'admin', image: null });
    await expect(ok.service.deleteAdmin(actor('owner'), 't')).resolves.toEqual({
      deleted: true,
    });
    expect(ok.remove.mock.calls[0][0].where).toEqual({ id: 't' });

    const blocked = setup({ id: 't', role: 'admin', image: null });
    blocked.remove.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );
    await expect(
      blocked.service.deleteAdmin(actor('dev'), 't'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
