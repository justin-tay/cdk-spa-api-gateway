import {
  buildHeaders,
  DEFAULT_CONTENT_SECURITY_POLICY,
  generateNonce,
  injectNonce,
} from '../../../src/assets/lambda/index-html';

describe('generateNonce', () => {
  it('is unguessable and different every time', () => {
    const nonces = new Set(Array.from({ length: 50 }, generateNonce));

    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    }
  });
});

describe('injectNonce', () => {
  it('replaces every occurrence of the default token', () => {
    const html = '<script nonce="__CSP_NONCE__"></script><style nonce="__CSP_NONCE__"></style>';

    expect(injectNonce(html, 'abc')).toBe('<script nonce="abc"></script><style nonce="abc"></style>');
  });

  it('replaces a custom token, literally', () => {
    expect(injectNonce('a $& a', 'abc$&', '$&')).toBe('a abc$& a');
  });

  it('leaves HTML without the token alone', () => {
    expect(injectNonce('<p>hi</p>', 'abc')).toBe('<p>hi</p>');
  });
});

describe('buildHeaders', () => {
  it('puts the nonce in the default CSP', () => {
    const headers = buildHeaders('abc');

    expect(headers['Content-Security-Policy']).toContain("script-src 'nonce-abc' 'strict-dynamic'");
    expect(headers['Content-Security-Policy']).not.toContain('{nonce}');
    expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
    expect(DEFAULT_CONTENT_SECURITY_POLICY).toContain('{nonce}');
  });

  it('is never cached and is not sniffed', () => {
    expect(buildHeaders('abc')).toMatchObject({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'text/html; charset=utf-8',
    });
  });

  it('takes a custom CSP and overriding headers', () => {
    const headers = buildHeaders('abc', "script-src 'nonce-{nonce}' {nonce}", {
      'Cache-Control': 'max-age=60',
      'X-Frame-Options': 'DENY',
    });

    expect(headers['Content-Security-Policy']).toBe("script-src 'nonce-abc' abc");
    expect(headers['Cache-Control']).toBe('max-age=60');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });
});
