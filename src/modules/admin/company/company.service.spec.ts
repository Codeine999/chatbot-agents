import type { FileStorageService } from '../../../infra/storage/file-storage.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { CompanyService } from './company.service';

const EXISTING = {
  id: 'company-1',
  name: 'Old',
  companyType: 'other',
  image: 'https://files.example.com/company/old.png',
};

function setup(updateError?: Error) {
  const update = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    updateError
      ? Promise.reject(updateError)
      : // Like Prisma, an undefined field leaves the column unchanged.
        Promise.resolve({
          ...EXISTING,
          ...Object.fromEntries(
            Object.entries(data).filter(([, value]) => value !== undefined),
          ),
        }),
  );
  const prisma = {
    company: {
      findFirst: jest.fn().mockResolvedValue(EXISTING),
      update,
    },
  } as unknown as PrismaService;
  const upload = jest
    .fn()
    .mockResolvedValue('https://files.example.com/company/new.png');
  const remove = jest.fn().mockResolvedValue(undefined);
  const storage = { upload, remove } as unknown as FileStorageService;

  return {
    service: new CompanyService(prisma, storage),
    update,
    upload,
    remove,
  };
}

const image = {
  fieldname: 'image',
  filename: 'logo.png',
  encoding: '7bit',
  mimetype: 'image/png',
  size: 3,
  buffer: Buffer.from('png'),
};

describe('CompanyService.updateCompany', () => {
  it('changes only the name without touching storage', async () => {
    const { service, update, upload, remove } = setup();

    const company = await service.updateCompany({
      name: 'New',
      image: undefined,
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'company-1' },
      data: { name: 'New', image: undefined },
    });
    expect(company.image).toBe(EXISTING.image);
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('stores the new image, then deletes the old one', async () => {
    const { service, update, upload, remove } = setup();

    const company = await service.updateCompany({ name: undefined, image });

    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: 'public',
        folder: 'company',
        contentType: 'image/png',
        extension: '.png',
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 'company-1' },
      data: {
        name: undefined,
        image: 'https://files.example.com/company/new.png',
      },
    });
    expect(company.name).toBe('Old');
    expect(remove).toHaveBeenCalledWith(EXISTING.image, 'company');
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0],
    );
  });

  it('keeps the old image and removes the new one when the update fails', async () => {
    const { service, remove } = setup(new Error('db down'));

    await expect(service.updateCompany({ name: 'New', image })).rejects.toThrow(
      'db down',
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(
      'https://files.example.com/company/new.png',
      'company',
    );
  });
});
