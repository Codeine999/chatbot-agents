import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RichMenuReplyService } from './rich-menu-reply.service';
import { RichMenuReplyCacheService } from '../../chatbot/menu/rich-menu-reply-cache.service';
import type {
  CreateRichMenuReplyDto,
  UpdateRichMenuReplyDto,
} from './dto/rich-menu-reply.dto';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

const reply = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'r1',
  tenantId: TENANT,
  key: 'register',
  label: 'สมัครสมาชิก',
  replyText: 'กรอกข้อมูลตามนี้ครับ',
  active: true,
  sortOrder: 0,
  createdByAdminId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function build(overrides: Record<string, unknown> = {}) {
  const prisma = {
    richMenuReply: {
      findMany: jest.fn().mockResolvedValue([reply()]),
      findFirst: jest.fn().mockResolvedValue(reply()),
      create: jest.fn().mockResolvedValue(reply()),
      update: jest.fn().mockResolvedValue(reply({ label: 'สมัครเลย' })),
      delete: jest.fn().mockResolvedValue(reply()),
    },
    richMenuTemplate: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  };

  const cache = { refresh: jest.fn().mockResolvedValue(undefined) };

  return {
    prisma,
    cache,
    service: new RichMenuReplyService(
      prisma as unknown as PrismaService,
      cache as unknown as RichMenuReplyCacheService,
    ),
  };
}

describe('RichMenuReplyService', () => {
  it('scopes every read to the caller tenant', async () => {
    const { prisma, service } = build();

    await service.list(TENANT, {} as never);

    expect(prisma.richMenuReply.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT }) }),
    );
  });

  it('treats the legacy null scope as a scope, not a wildcard', async () => {
    const { prisma, service } = build();

    await service.list(null, {} as never);

    expect(prisma.richMenuReply.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: null }) }),
    );
  });

  it('cannot read another tenant row by id', async () => {
    const { prisma, service } = build();
    prisma.richMenuReply.findFirst.mockResolvedValue(null);

    await expect(service.get(OTHER_TENANT, 'r1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.richMenuReply.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', tenantId: OTHER_TENANT },
    });
  });

  it('stores the caller tenant on create rather than anything from the body', async () => {
    const { prisma, service } = build();

    await service.create(TENANT, {
      key: 'register',
      label: 'สมัครสมาชิก',
      replyText: 'ข้อความ',
      active: true,
      sortOrder: 0,
      // A body that tries to name a tenant must not be able to.
      tenantId: OTHER_TENANT,
    } as unknown as CreateRichMenuReplyDto);

    expect(prisma.richMenuReply.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: TENANT, key: 'register' }),
    });
  });

  it('reports a duplicate key as a conflict, not a raw database error', async () => {
    const { prisma, service } = build();
    prisma.richMenuReply.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7',
      }),
    );

    await expect(
      service.create(TENANT, {
        key: 'register',
        label: 'x',
        replyText: 'y',
        active: true,
        sortOrder: 0,
      } as CreateRichMenuReplyDto),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to delete a reply a live button still points at', async () => {
    const { prisma, service } = build();
    prisma.richMenuTemplate.findMany.mockResolvedValue([
      {
        id: 't1',
        name: 'เมนูหลัก',
        status: 'PUBLISHED',
        areas: [
          { bounds: {}, action: { type: 'postback', data: 'menu=register' } },
        ],
      },
    ]);

    await expect(service.remove(TENANT, 'r1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.richMenuReply.delete).not.toHaveBeenCalled();
  });

  it('deletes a reply nothing points at', async () => {
    const { prisma, service } = build();

    await expect(service.remove(TENANT, 'r1')).resolves.toEqual({
      id: 'r1',
      deleted: true,
    });
    expect(prisma.richMenuReply.delete).toHaveBeenCalled();
  });

  it('reloads the bot copy so a new button answers right away', async () => {
    const { cache, service } = build();

    await service.create(TENANT, {
      key: 'register',
      label: 'x',
      replyText: 'y',
      active: true,
      sortOrder: 0,
    } as CreateRichMenuReplyDto);

    expect(cache.refresh).toHaveBeenCalled();
  });

  it('still saves when the bot copy cannot be reloaded', async () => {
    const { cache, service } = build();
    cache.refresh.mockRejectedValue(new Error('cache down'));

    await expect(
      service.create(TENANT, {
        key: 'register',
        label: 'x',
        replyText: 'y',
        active: true,
        sortOrder: 0,
      } as CreateRichMenuReplyDto),
    ).resolves.toMatchObject({ key: 'register' });
  });

  it('never lets an update move a row between tenants', async () => {
    const { prisma, service } = build();

    await service.update(TENANT, 'r1', {
      label: 'สมัครเลย',
    } as UpdateRichMenuReplyDto);

    expect(prisma.richMenuReply.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', tenantId: TENANT },
    });
    expect(prisma.richMenuReply.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ tenantId: expect.anything() }),
      }),
    );
  });

  it('reports which templates use a reply, ignoring other postback grammars', async () => {
    const { prisma, service } = build();
    prisma.richMenuTemplate.findMany.mockResolvedValue([
      {
        id: 't1',
        name: 'เมนูหลัก',
        status: 'PUBLISHED',
        areas: [
          { bounds: {}, action: { type: 'postback', data: 'menu=register' } },
          { bounds: {}, action: { type: 'postback', data: 'intent=REGISTER' } },
          { bounds: {}, action: { type: 'uri', uri: 'https://example.com' } },
        ],
      },
    ]);

    const [view] = await service.list(TENANT, {} as never);

    expect(view.postbackData).toBe('menu=register');
    expect(view.usedByTemplates).toEqual([
      { id: 't1', name: 'เมนูหลัก', status: 'PUBLISHED' },
    ]);
  });

  it('survives an areas column that is not the shape it should be', async () => {
    const { prisma, service } = build();
    prisma.richMenuTemplate.findMany.mockResolvedValue([
      { id: 't1', name: 'broken', status: 'DRAFT', areas: { not: 'an array' } },
    ]);

    const [view] = await service.list(TENANT, {} as never);

    expect(view.usedByTemplates).toEqual([]);
  });
});
