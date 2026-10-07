import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyResult } from 'aws-lambda';

/**
 * A JWK as stored in a JWKS secret. Private members are present on private keys only.
 * The `use` of every key in a secret is the same.
 */
interface Jwk {
  readonly kid: string;
  readonly use: 'sig' | 'enc';
  readonly [member: string]: unknown;
}

interface Jwks {
  readonly keys: readonly Jwk[];
}

// A secret holds a JWKS, public and private keys together, as written by whatever rotates it. This endpoint
// checks only the shape of the secret, and never serves a private member.

/** Number of keys a secret keeps at most. */
const MAX_KEY_COUNT = 3;

/** Members of a private JWK that a public JWK must not have (RFC 7518 sections 6.2.2 and 6.3.2). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'] as const;

/** Parses a secret string holding a JWKS, checking its shape. */
function parseJwks(secretString: string): Jwks {
  const parsed: unknown = JSON.parse(secretString);
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'object' || key === null)) {
    throw new Error('The secret is not a JWKS: it must be {"keys":[...]}');
  }
  return { keys: keys as Jwk[] };
}

/** Returns a copy of the JWK without its private members. */
function toPublicJwk(jwk: Jwk): Jwk {
  const copy: Record<string, unknown> = { ...jwk };
  for (const member of PRIVATE_MEMBERS) {
    delete copy[member];
  }
  return copy as unknown as Jwk;
}

/**
 * The JWKS to serve: the keys the OpenID Connect server may use, without private members.
 *
 * - `sig`: every key. The retired key stays published so assertions signed by a server instance with a
 *   cached secret still verify.
 * - `enc`: every key except the oldest once there are 3. The oldest is dropped at the next rotation, so it
 *   is unpublished one rotation early while its private key is kept to decrypt anything still encrypted to it.
 */
function toPublicJwks(jwks: Jwks): Jwks {
  const { keys } = jwks;
  const published = keys[0]?.use === 'enc' && keys.length === MAX_KEY_COUNT ? keys.slice(1) : keys;
  return { keys: published.map(toPublicJwk) };
}

/** ARNs of the JWKS secrets whose public keys are served together. */
const SECRET_ARNS: readonly string[] = JSON.parse(process.env.JWKS_SECRET_ARNS ?? '[]');

/** How long each secret is cached; also the Cache-Control max-age. 0 disables caching. */
const CACHE_TTL_SECONDS = Number(process.env.JWKS_CACHE_SECONDS ?? '0');

const client = new SecretsManagerClient({});

const cache = new Map<string, { readonly jwks: Jwks; readonly expiresAt: number }>();

/** Whether a JWKS may be cached; not the empty JWKS served before the first rotation completes. */
function isCacheable(jwks: Jwks): boolean {
  return CACHE_TTL_SECONDS > 0 && jwks.keys.length > 0;
}

async function getJwks(secretArn: string): Promise<Jwks> {
  const cached = cache.get(secretArn);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.jwks;
  }
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const jwks = parseJwks(SecretString ?? '');
  if (isCacheable(jwks)) {
    cache.set(secretArn, { jwks, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
  } else {
    cache.delete(secretArn);
  }
  return jwks;
}

/**
 * Serves the public keys of the JWKS secrets. Only GET is routed here by API Gateway, so there is
 * no method check. A secret that cannot be read is a 500 (the platform's own error), not an empty set.
 */
export async function handler(): Promise<APIGatewayProxyResult> {
  const jwksList = await Promise.all(SECRET_ARNS.map(getJwks));
  // toPublicJwks applies the publishing rule for each secret's use (sig or enc).
  const keys = jwksList.flatMap((jwks) => toPublicJwks(jwks).keys);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': jwksList.every(isCacheable) ? `public, max-age=${CACHE_TTL_SECONDS}` : 'no-cache',
    },
    body: JSON.stringify({ keys }),
  };
}
