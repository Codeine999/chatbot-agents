import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiSetting } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuthenticatedAdmin } from '../../../shared/guards/admin-auth.types';
import { AdminAiSettingService } from './admin-ai-setting.service';
import type { CreateAdminAiSettingDto } from './dto/admin-ai-setting.dto';

const now = new Date('2026-09-19T00:00:00.000Z');
const setting: AiSetting = {
  id: '00000000-0000-4000-8000-000000000001',
  tenantId: null,
  systemPrompt: 'platform rules',
  ownerPrompt: 'hotel admin',
  tone: 'friendly',
  skills: [{ name: 'sales', prompt: 'answer naturally' }],
  responseStyle: { targetLength: 'short', emojiLevel: 'light' },
  promptVersion: 1,
  fallbackMessage: 'contact admin',
  active: true,
  createdAt: now,
  updatedAt: now,
};

const admin = (role: AuthenticatedAdmin['role']): AuthenticatedAdmin => ({
  id: `${role}-id`,
  username: role,
  firstName: role,
  lastName: 'tester',
  email: `${role}@example.com`,
  phone: '0000000000',
  image: null,
  companyId: null,
  role,
});

const createInput = {
  ownerPrompt: 'hotel admin',
  tone: 'friendly',
  skills: [{ name: 'sales', prompt: 'answer naturally' }],
  responseStyle: { targetLength: 'short', emojiLevel: 'light' },
  promptVersion: 1,
  fallbackMessage: 'contact admin',
  active: true,
} as CreateAdminAiSettingDto;

function build() {
  const prisma = {
    aiSetting: {
      findMany: jest.fn().mockResolvedValue([setting]),
      findFirst: jest.fn().mockResolvedValue({ id: setting.id }),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ ...setting, ...data }),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ ...setting, ...data }),
        ),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  return {
    prisma,
    service: new AdminAiSettingService(
      prisma as unknown as PrismaService,
      new ConfigService(),
    ),
  };
}

describe('AdminAiSettingService authorization and CRUD', () => {
  it('lets ADMIN read settings without exposing systemPrompt', async () => {
    const result = await build().service.list(admin('admin'));

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('systemPrompt');
  });

  it('lets DEV read settings including systemPrompt', async () => {
    const result = await build().service.list(admin('dev'));

    expect(result[0]).toHaveProperty('systemPrompt', 'platform rules');
  });

  it('lets ADMIN create business-configurable fields', async () => {
    const ctx = build();

    const result = await ctx.service.create(createInput, admin('admin'));

    expect(result).not.toHaveProperty('systemPrompt');
    expect(ctx.prisma.aiSetting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: null,
        ownerPrompt: 'hotel admin',
        tone: 'friendly',
        skills: createInput.skills,
        responseStyle: createInput.responseStyle,
        active: true,
      }) as unknown,
    });
  });

  it('rejects systemPrompt from ADMIN during creation', async () => {
    const ctx = build();

    await expect(
      ctx.service.create(
        { ...createInput, systemPrompt: 'override platform' },
        admin('admin'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.prisma.aiSetting.create).not.toHaveBeenCalled();
  });

  it('rejects a tenantId outside the trusted deployment scope', async () => {
    const ctx = build();

    await expect(
      ctx.service.create(
        {
          ...createInput,
          tenantId: '00000000-0000-4000-8000-000000000099',
        },
        admin('admin'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.prisma.aiSetting.create).not.toHaveBeenCalled();
  });

  it('lets DEV set systemPrompt during creation', async () => {
    const ctx = build();

    await ctx.service.create(
      { ...createInput, systemPrompt: 'new platform rules' },
      admin('dev'),
    );

    expect(ctx.prisma.aiSetting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        systemPrompt: 'new platform rules',
      }) as unknown,
    });
  });

  it.each([
    ['ownerPrompt', 'new owner'],
    ['tone', 'concise'],
    ['skills', [{ name: 'support', prompt: 'be helpful' }]],
    ['responseStyle', { targetLength: 'medium', emojiLevel: 'normal' }],
    ['active', false],
  ] as const)('lets ADMIN patch %s', async (field, value) => {
    const ctx = build();

    await ctx.service.update(setting.id, { [field]: value }, admin('admin'));

    expect(ctx.prisma.aiSetting.update).toHaveBeenCalledWith({
      where: { id: setting.id },
      data: expect.objectContaining({ [field]: value }) as unknown,
    });
  });

  it('rejects systemPrompt from ADMIN during patch', async () => {
    const ctx = build();

    await expect(
      ctx.service.update(
        setting.id,
        { systemPrompt: 'override platform' },
        admin('admin'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.prisma.aiSetting.update).not.toHaveBeenCalled();
  });

  it('lets DEV patch systemPrompt', async () => {
    const ctx = build();

    await ctx.service.update(
      setting.id,
      { systemPrompt: 'new platform rules' },
      admin('dev'),
    );

    expect(ctx.prisma.aiSetting.update).toHaveBeenCalledWith({
      where: { id: setting.id },
      data: { systemPrompt: 'new platform rules' },
    });
  });

  it('lets ADMIN delete a setting in the configured scope', async () => {
    const ctx = build();

    await expect(
      ctx.service.remove(setting.id, admin('admin')),
    ).resolves.toEqual({ deleted: true });
    expect(ctx.prisma.aiSetting.deleteMany).toHaveBeenCalledWith({
      where: { id: setting.id, tenantId: null },
    });
  });
});
