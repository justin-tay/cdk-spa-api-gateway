const send = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ input })),
}));

const ARN = 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:jwks-AbCdEf';

const rsa = (kid: string, use: 'sig' | 'enc', extra: Record<string, string> = {}) => ({
  kty: 'RSA',
  kid,
  use,
  alg: use === 'sig' ? 'PS256' : 'RSA-OAEP-256',
  n: 'modulus',
  e: 'AQAB',
  ...extra,
});
const privateRsa = (kid: string, use: 'sig' | 'enc') =>
  rsa(kid, use, { d: 'd', p: 'p', q: 'q', dp: 'dp', dq: 'dq', qi: 'qi' });

type Handler = () => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;

function load(env: Record<string, string> = {}): Handler {
  jest.resetModules();
  process.env.JWKS_SECRET_ARNS = JSON.stringify([ARN]);
  delete process.env.JWKS_CACHE_SECONDS;
  Object.assign(process.env, env);
  return jest.requireActual('../../../bin/handlers/jwks-endpoint').handler;
}

function secret(keys: unknown[]): void {
  send.mockResolvedValue({ SecretString: JSON.stringify({ keys }) });
}

beforeEach(() => send.mockReset());

describe('JWKS endpoint handler', () => {
  it('reads the secret it is given', async () => {
    secret([]);

    await load()();

    expect(send.mock.calls[0][0].input).toEqual({ SecretId: ARN });
  });

  it('serves the public keys and never a private member', async () => {
    secret([privateRsa('a', 'sig'), privateRsa('b', 'sig')]);

    const response = await load()();

    const { keys } = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(keys).toEqual([rsa('a', 'sig'), rsa('b', 'sig')]);
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) {
      expect(response.body).not.toContain(`"${member}"`);
    }
  });

  it('publishes every sig key, including the retired one', async () => {
    secret([rsa('retired', 'sig'), privateRsa('a', 'sig'), privateRsa('b', 'sig')]);

    const { keys } = JSON.parse((await load()()).body);

    expect(keys.map((key: { kid: string }) => key.kid)).toEqual(['retired', 'a', 'b']);
  });

  it('unpublishes the oldest enc key once there are three', async () => {
    secret([privateRsa('oldest', 'enc'), privateRsa('a', 'enc'), privateRsa('b', 'enc')]);

    const { keys } = JSON.parse((await load()()).body);

    expect(keys.map((key: { kid: string }) => key.kid)).toEqual(['a', 'b']);
  });

  it('publishes both enc keys while there are only two', async () => {
    secret([privateRsa('a', 'enc'), privateRsa('b', 'enc')]);

    const { keys } = JSON.parse((await load()()).body);

    expect(keys).toHaveLength(2);
  });

  it('serves an empty set before the first rotation, and does not let it be cached', async () => {
    secret([]);

    const response = await load({ JWKS_CACHE_SECONDS: '300' })();

    expect(JSON.parse(response.body)).toEqual({ keys: [] });
    expect(response.headers['Cache-Control']).toBe('no-cache');
  });

  it('caches the secret and says so in Cache-Control', async () => {
    secret([privateRsa('a', 'sig'), privateRsa('b', 'sig')]);
    const handler = load({ JWKS_CACHE_SECONDS: '300' });

    const first = await handler();
    await handler();

    expect(send).toHaveBeenCalledTimes(1);
    expect(first.headers['Cache-Control']).toBe('public, max-age=300');
  });

  it('does not cache by default', async () => {
    secret([privateRsa('a', 'sig'), privateRsa('b', 'sig')]);
    const handler = load();

    const response = await handler();
    await handler();

    expect(send).toHaveBeenCalledTimes(2);
    expect(response.headers['Cache-Control']).toBe('no-cache');
  });

  it('serves the keys of several secrets together', async () => {
    send
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ keys: [privateRsa('s1', 'sig')] }) })
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ keys: [privateRsa('s2', 'sig')] }) });

    const { keys } = JSON.parse(
      (await load({ JWKS_SECRET_ARNS: JSON.stringify([`${ARN}1`, `${ARN}2`]) })()).body,
    );

    expect(keys.map((key: { kid: string }) => key.kid)).toEqual(['s1', 's2']);
  });

  it.each([
    ['not JSON', 'not json'],
    ['not a JWKS', '{"nokeys":true}'],
    ['keys that are not objects', '{"keys":[1]}'],
    ['null', 'null'],
  ])('rejects a secret that is %s, rather than serve something else', async (_name, secretString) => {
    send.mockResolvedValue({ SecretString: secretString });

    await expect(load()()).rejects.toThrow(/JSON|JWKS/);
  });

  it('rejects a secret with no string', async () => {
    send.mockResolvedValue({});

    await expect(load()()).rejects.toThrow(/JSON|JWKS/);
  });
});
