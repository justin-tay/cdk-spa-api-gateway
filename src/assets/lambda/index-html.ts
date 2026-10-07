import { randomBytes } from 'node:crypto';

export const DEFAULT_NONCE_TOKEN = '__CSP_NONCE__';

export const DEFAULT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'nonce-{nonce}' 'strict-dynamic'",
  "style-src 'self' 'nonce-{nonce}'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  // The page differs per request (the nonce), so it must not be stored.
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** A fresh, unguessable nonce for one response. */
export function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Replaces every occurrence of `token` in `html` with `nonce`. */
export function injectNonce(html: string, nonce: string, token: string = DEFAULT_NONCE_TOKEN): string {
  return html.split(token).join(nonce);
}

/** The response headers for the HTML: the defaults, the CSP for this nonce, then the caller's overrides. */
export function buildHeaders(
  nonce: string,
  contentSecurityPolicy: string = DEFAULT_CONTENT_SECURITY_POLICY,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...DEFAULT_HEADERS,
    'Content-Security-Policy': contentSecurityPolicy.split('{nonce}').join(nonce),
    ...additionalHeaders,
  };
}
