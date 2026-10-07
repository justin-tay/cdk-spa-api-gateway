# Routing

`SpaApiGateway` creates one REST API with these resources. API Gateway always picks the **most specific** matching resource, so the order you read them in is the order of precedence.

| Resource                                           | Methods       | Integration                               |
| -------------------------------------------------- | ------------- | ----------------------------------------- |
| `/`                                                | `GET`         | Lambda proxy                              |
| `/index.html`                                      | `GET`         | Lambda proxy                              |
| `/assets/{proxy+}` (each `staticPaths`)            | `GET`, `HEAD` | S3 service integration                    |
| `/favicon.svg`, `/sw.js`, ... (each `staticFiles`) | `GET`, `HEAD` | S3 service integration                    |
| `/api`                                             | `ANY`         | HTTP proxy                                |
| `/api/{proxy+}`                                    | `ANY`         | HTTP proxy                                |
| `/{proxy+}`                                        | `GET`         | Lambda proxy (S3 if `spaFallback: false`) |

## Why the catch-all goes to the Lambda

A browser app with client-side routing (`BrowserRouter`) has URLs such as `/dashboard` that are not files. Refreshing on one must return `index.html`. API Gateway cannot do that from an S3 integration: an integration response cannot re-issue the request with a different key, so a missing key can only be turned into an error or a fixed body, and neither carries the nonce.

So the routing is inverted: S3 handles only the paths that are known to be files (`/assets` and the root files), and the Lambda handles everything else. The nonce and the headers apply to every route the user can refresh on.

The cost is that an unknown path such as `/missing.js` returns the app shell with a `200`. Paths under `/assets` and the files in `staticFiles` do return a `404` problem. With `spaFallback: false`, `/{proxy+}` goes to S3 and everything that is not a file returns a `404` problem; this suits an app that uses hash routing (`/#/dashboard`).

## Choosing `staticPaths` and `staticFiles`

Use `staticPaths` for a directory whose contents change with each build (hashed JS, CSS, fonts, images). Each entry must end in `/{proxy+}`; `/assets/{proxy+}` serves the object at `assets/<rest of the path>`.

Use `staticFiles` for single files at fixed paths. The defaults cover a PWA: `/favicon.svg`, `/favicon.ico`, `/manifest.webmanifest`, `/sw.js` and `/robots.txt`. A file that is listed but not in the bucket returns a `404` problem. A service worker must be served from the root to control the whole origin, so it belongs in `staticFiles`.

`/sw.js` and `/manifest.webmanifest` are sent with `Cache-Control: no-cache`, so an update is picked up on the next load. Every other file passes through the `Cache-Control` of its S3 object, so set `Cache-Control: public, max-age=31536000, immutable` on hashed assets when you upload them.

Anything else the app needs at the root, such as `/apple-touch-icon.png` or `/.well-known/assetlinks.json`, goes in `staticFiles` too.

## S3 errors

API Gateway maps S3's status to a problem details object ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) with `Content-Type: application/problem+json`:

| S3 status    | Response                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `403`, `404` | `404` `{"title":"Not Found","status":404,"detail":"The requested resource was not found."}`      |
| other `4xx`  | `400` `{"title":"Bad Request","status":400,"detail":"The request could not be processed."}`      |
| `5xx`        | `502` `{"title":"Bad Gateway","status":502,"detail":"The resource is temporarily unavailable."}` |

`type` is left out, which means `about:blank`: no meaning beyond the HTTP status, and `title` is that status's standard phrase. `detail` is a fixed message that never repeats S3's own error, so nothing about the bucket leaks. The request ID is in the `x-amzn-RequestId` response header.

S3 answers `403` rather than `404` for a missing key when the caller may not list the bucket. The API's role is granted `s3:ListBucket`, so a missing key is a real `404`, and a genuine `403` is also reported as `404` so that the bucket's contents are not revealed.

## Success responses

`Content-Type`, `ETag`, `Last-Modified` and `Cache-Control` are copied from the S3 object. The API sets `binaryMediaTypes: ['*/*']` so that fonts and images pass through unchanged.

## Errors from API Gateway itself

The errors API Gateway raises itself are answered as problem details too: `401`, `403` (an unknown route or method is "missing authentication token"), `404`, `413`, `415`, `429` (throttling and quota), `502` and `504` (the backend failed or timed out). Each keeps its status code. Any other `4xx` or `5xx` gets a problem with a `title` and `detail` and no `status`, since the status of those is not known to the template (`status` is optional in RFC 9457). A client that sends `Accept: application/problem+json` gets `Content-Type: application/problem+json`; any other client gets `application/json`, because API Gateway chooses the media type from the template that matches `Accept` and ignores a `Content-Type` header set on a gateway response. The `/api` backend's own error responses pass through unchanged.
