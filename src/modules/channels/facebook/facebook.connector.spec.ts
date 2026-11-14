import { createHmac, randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { CompanyService } from '../../admin/company/company.service';
import { ChannelConnectorRegistry } from '../channel-connector.registry';
import { FacebookConfig } from './facebook.config';
import { FacebookConnector } from './facebook.connector';
import { FacebookCredentialService } from './facebook-credential.service';

const KEY = randomBytes(32).toString('base64');
const CHANNEL_KEY = 'abcdefghijklmnop1234';
const PAGE_ID = '1001';
const APP_SECRET = '0123456789abcdef0123456789abcdef';

function build(env: Record<string, string> = {}) {
  const values: Record<string, string> = {
    CREDENTIAL_ENC_KEY_V1: KEY,
    ...env,
  };
  const config = { get: (name: string) => values[name] } as ConfigService;
  const prisma = {
    facebookChannel: {
      findUnique: jest.fn(),
    },
  };
  const credentials = new FacebookCredentialService(
    prisma as unknown as PrismaService,
    config,
    new FacebookConfig(config),
    { getCompanyId: () => Promise.resolve('env-company') } as CompanyService,
  );
  const connector = new FacebookConnector(
    new FacebookConfig(config),
    new ChannelConnectorRegistry(),
    credentials,
  );
  const sealed = (plain: string) => credentials.seal(plain).ciphertext;
  const row = {
    id: 'row-1',
    companyId: 'company-a',
    channelKey: CHANNEL_KEY,
    pageId: PAGE_ID,
    appSecretCiphertext: sealed(APP_SECRET),
    pageAccessTokenCiphertext: sealed('page-token'),
    verifyTokenCiphertext: sealed('verify-token-1234567'),
    encKeyVersion: 1,
  };
  prisma.facebookChannel.findUnique.mockImplementation(
    ({ where }: { where: { channelKey?: string; pageId?: string } }) =>
      Promise.resolve(
        where.channelKey === CHANNEL_KEY || where.pageId === PAGE_ID
          ? row
          : null,
      ),
  );
  return { connector, credentials, prisma };
}

const sign = (body: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const payload = (pageId: string) =>
  JSON.stringify({
    object: 'page',
    entry: [
      {
        id: pageId,
        messaging: [
          {
            sender: { id: 'psid-1' },
            recipient: { id: pageId },
            timestamp: 1,
            message: { mid: 'm1', text: 'สวัสดี' },
          },
        ],
      },
    ],
  });

describe('FacebookConnector with database credentials', () => {
  it('accepts a body signed with the Page secret from the URL key', async () => {
    const { connector } = build();
    const body = payload(PAGE_ID);
    await expect(
      connector.verifySignature({
        routeKey: CHANNEL_KEY,
        rawBody: body,
        headers: { 'x-hub-signature-256': sign(body) },
        body: JSON.parse(body) as unknown,
      }),
    ).resolves.toBe(true);
  });

  it('rejects a wrong signature, an unknown key and the bare URL without env', async () => {
    const { connector } = build();
    const body = payload(PAGE_ID);
    const request = (routeKey: string | undefined, secret: string) => ({
      routeKey,
      rawBody: body,
      headers: { 'x-hub-signature-256': sign(body, secret) },
      body: JSON.parse(body) as unknown,
    });
    await expect(
      connector.verifySignature(request(CHANNEL_KEY, 'f'.repeat(32))),
    ).resolves.toBe(false);
    await expect(
      connector.verifySignature(request('zzzzzzzzzzzzzzzzzzzz', APP_SECRET)),
    ).resolves.toBe(false);
    await expect(
      connector.verifySignature(request(undefined, APP_SECRET)),
    ).resolves.toBe(false);
  });

  it('answers the handshake only with the stored verify token', async () => {
    const { connector } = build();
    const query = (token: string) => ({
      'hub.mode': 'subscribe',
      'hub.verify_token': token,
      'hub.challenge': 'abc',
    });
    await expect(
      connector.verifyChallenge(query('verify-token-1234567'), CHANNEL_KEY),
    ).resolves.toBe('abc');
    await expect(
      connector.verifyChallenge(query('nope-nope-nope-nope'), CHANNEL_KEY),
    ).resolves.toBeNull();
  });

  it('keeps only entries of the Page that owns the URL key', async () => {
    const { connector } = build();
    expect(
      await connector.parse(JSON.parse(payload(PAGE_ID)), CHANNEL_KEY),
    ).toHaveLength(1);
    expect(
      await connector.parse(JSON.parse(payload('2002')), CHANNEL_KEY),
    ).toHaveLength(0);
  });

  it('resolves the company from the Page id, never from the payload', async () => {
    const { connector } = build();
    await expect(connector.resolveCompany(PAGE_ID)).resolves.toBe('company-a');
    await expect(connector.resolveCompany('2002')).resolves.toBeNull();
  });

  it('serves the legacy Page from env on the bare URL', async () => {
    const { connector } = build({
      FACEBOOK_ENABLED: 'true',
      FACEBOOK_APP_SECRET: 'legacy-secret',
      FACEBOOK_PAGE_ACCESS_TOKEN: 'legacy-token',
      FACEBOOK_VERIFY_TOKEN: 'legacy-verify-token-1',
      FACEBOOK_PAGE_ID: '3003',
    });
    const body = payload('3003');
    await expect(
      connector.verifySignature({
        rawBody: body,
        headers: { 'x-hub-signature-256': sign(body, 'legacy-secret') },
        body: JSON.parse(body) as unknown,
      }),
    ).resolves.toBe(true);
    await expect(connector.resolveCompany('3003')).resolves.toBe('env-company');
  });

  it('sends with the token of the Page named in the target', async () => {
    const { connector } = build();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ message_id: 'out-1' }), { status: 200 }),
      );
    const result = await connector.send(
      { accountId: PAGE_ID, externalUserId: 'psid-1' },
      'hi',
    );
    expect(result).toEqual({ ok: true, externalMessageId: 'out-1' });
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer page-token',
    );
    await expect(
      connector.send({ accountId: '2002', externalUserId: 'x' }, 'hi'),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      code: 'FB_NOT_CONFIGURED',
    });
    fetchMock.mockRestore();
  });
});
