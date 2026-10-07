# Security headers and the nonce

The index Lambda serves `index.html` for `/`, `/index.html` and, by default, every unmatched path.

## How the nonce works

1. The Lambda reads `index.html` from the bucket. The page is kept in memory per container and revalidated with the object's ETag (`If-None-Match`), so a warm invocation does not download it again, and a deployment of a new page is picked up immediately.
2. It generates a fresh 128-bit nonce for the request.
3. It replaces every occurrence of the placeholder (`__CSP_NONCE__` by default; see `nonceToken`) with the nonce.
4. It returns the page with the headers below, where `{nonce}` in the CSP is the same nonce.

If the page cannot be read, the Lambda answers `500` with a problem details body, `{"title":"Internal Server Error","status":500,"detail":"The page is unavailable."}`, as `application/problem+json`.

Put the placeholder on every `<script>` and `<style>`/`<link rel="stylesheet">` the page loads:

```html
<script type="module" src="/assets/index.js" nonce="__CSP_NONCE__"></script>
<link rel="stylesheet" href="/assets/index.css" nonce="__CSP_NONCE__" />
<meta property="csp-nonce" nonce="__CSP_NONCE__" />
```

The `<meta property="csp-nonce">` form is what some libraries, such as styled-component and MUI/emotion setups, read to pass the nonce on to the styles they inject.

## Default headers

| Header                       | Value                                          |
| ---------------------------- | ---------------------------------------------- |
| `Content-Security-Policy`    | see below                                      |
| `Content-Type`               | `text/html; charset=utf-8`                     |
| `Cache-Control`              | `no-store` (the page differs on every request) |
| `Strict-Transport-Security`  | `max-age=63072000; includeSubDomains`          |
| `X-Content-Type-Options`     | `nosniff`                                      |
| `Referrer-Policy`            | `strict-origin-when-cross-origin`              |
| `Permissions-Policy`         | `camera=(), microphone=(), geolocation=()`     |
| `Cross-Origin-Opener-Policy` | `same-origin`                                  |

The default CSP is:

```
default-src 'self'; script-src 'nonce-{nonce}' 'strict-dynamic'; style-src 'self' 'nonce-{nonce}';
img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
form-action 'self'; frame-ancestors 'none'
```

(In the header it is on one line.) `'strict-dynamic'` lets a nonced script load further scripts.

## Customising

Replace the whole CSP with `contentSecurityPolicy`; `{nonce}` is substituted:

```ts
new SpaApiGateway(this, 'Spa', {
  backend: { url: 'https://api.example.com' },
  contentSecurityPolicy:
    "default-src 'self'; script-src 'nonce-{nonce}' 'strict-dynamic'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' https://images.example.com data:",
});
```

Add or override any other header with `additionalHeaders`; an entry replaces the default of the same name:

```ts
additionalHeaders: { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-cache' },
```

Common reasons to change the CSP: inline `style` attributes (React `style={...}`) are blocked by `style-src` without `'unsafe-inline'`, and a font or image CDN needs its origin in `font-src`/`img-src`.

## What is not covered

- The headers apply to the HTML only. Static assets from S3 carry the headers of their S3 objects, plus the ones API Gateway adds.
- A service worker that caches `index.html` replays that page's nonce on every offline load. The construct does not handle this.
