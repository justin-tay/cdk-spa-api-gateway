const send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send })),
  GetObjectCommand: jest.fn((input: unknown) => ({ input })),
}));

function body(html: string): { transformToString: () => Promise<string> } {
  return { transformToString: async () => html };
}

const HTML = '<script nonce="__CSP_NONCE__"></script>';

describe('index page handler', () => {
  let handler: () => Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  }>;

  beforeEach(() => {
    jest.resetModules();
    send.mockReset();
    process.env.BUCKET_NAME = 'bucket';
    delete process.env.NONCE_TOKEN;
    delete process.env.CONTENT_SECURITY_POLICY;
    delete process.env.ADDITIONAL_HEADERS;
    ({ handler } = jest.requireActual('../../../../src/assets/lambda/handlers/index-page'));
  });

  it('serves the page with the nonce and the headers', async () => {
    send.mockResolvedValue({ Body: body(HTML), ETag: '"1"' });

    const response = await handler();

    const nonce = /nonce="([^"]+)"/.exec(response.body)?.[1];
    expect(nonce).toBeDefined();
    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Security-Policy']).toContain(`'nonce-${nonce}'`);
    expect(response.headers['Cache-Control']).toBe('no-store');
  });

  it('uses a new nonce for every response', async () => {
    send.mockResolvedValue({ Body: body(HTML), ETag: '"1"' });

    const [first, second] = [await handler(), await handler()];

    expect(first.body).not.toBe(second.body);
  });

  it('revalidates a cached page by ETag and reuses it when it is not modified', async () => {
    send.mockResolvedValueOnce({ Body: body(HTML), ETag: '"1"' });
    await handler();
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 304 } });

    const response = await handler();

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/nonce="[^_]/);
    expect(send.mock.calls[1][0].input).toMatchObject({ Key: 'index.html', IfNoneMatch: '"1"' });
  });

  it('serves the new page when it changed', async () => {
    send.mockResolvedValueOnce({ Body: body(HTML), ETag: '"1"' });
    await handler();
    send.mockResolvedValueOnce({ Body: body('<p>new</p>'), ETag: '"2"' });

    expect((await handler()).body).toBe('<p>new</p>');
  });

  it('does not cache a page without an ETag', async () => {
    send.mockResolvedValueOnce({ Body: body(HTML) });
    await handler();
    send.mockResolvedValueOnce({ Body: body(HTML) });
    await handler();

    expect(send.mock.calls[1][0].input.IfNoneMatch).toBeUndefined();
  });

  it('answers 500 as problem details when the page cannot be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    send.mockRejectedValue(new Error('NoSuchKey'));

    const response = await handler();

    expect(response.statusCode).toBe(500);
    expect(response.headers['Content-Type']).toBe('application/problem+json');
    expect(JSON.parse(response.body)).toEqual({
      title: 'Internal Server Error',
      status: 500,
      detail: 'The page is unavailable.',
    });
  });

  it('answers 500 for an error that is not "not modified", even when a page is cached', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    send.mockResolvedValueOnce({ Body: body(HTML), ETag: '"1"' });
    await handler();
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 500 } });

    expect((await handler()).statusCode).toBe(500);
  });

  it('takes the token, the CSP and extra headers from the environment', async () => {
    process.env.NONCE_TOKEN = '@@N@@';
    process.env.CONTENT_SECURITY_POLICY = "script-src 'nonce-{nonce}'";
    process.env.ADDITIONAL_HEADERS = '{"X-Frame-Options":"DENY"}';
    send.mockResolvedValue({ Body: body('<i nonce="@@N@@">'), ETag: '"1"' });

    const response = await handler();

    expect(response.body).not.toContain('@@N@@');
    expect(response.headers['Content-Security-Policy']).toMatch(/^script-src 'nonce-.+'$/);
    expect(response.headers['X-Frame-Options']).toBe('DENY');
  });
});
