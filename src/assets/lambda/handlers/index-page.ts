import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyResult } from 'aws-lambda';
import {
  buildHeaders,
  DEFAULT_CONTENT_SECURITY_POLICY,
  DEFAULT_NONCE_TOKEN,
  generateNonce,
  injectNonce,
} from '../index-html';
import { PROBLEM_CONTENT_TYPE, problemJson } from '../problem-details';

const s3 = new S3Client({});

/** The last index.html read, kept for the life of the container and revalidated by ETag. */
let cached: { etag: string; html: string } | undefined;

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function isNotModified(error: unknown): boolean {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 304;
}

async function loadIndexHtml(bucket: string, key: string): Promise<string> {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: cached?.etag }),
    );
    const html = (await response.Body?.transformToString('utf-8')) ?? '';
    cached = response.ETag ? { etag: response.ETag, html } : undefined;
    return html;
  } catch (error) {
    if (cached && isNotModified(error)) {
      return cached.html;
    }
    throw error;
  }
}

/** Serves index.html with a per-request CSP nonce and the security headers. */
export async function handler(): Promise<APIGatewayProxyResult> {
  const bucket = process.env.BUCKET_NAME!;
  const key = env('INDEX_KEY', 'index.html');
  const nonce = generateNonce();

  let html: string;
  try {
    html = await loadIndexHtml(bucket, key);
  } catch (error) {
    console.error('Failed to read the index page', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': PROBLEM_CONTENT_TYPE, 'Cache-Control': 'no-store' },
      body: problemJson({
        title: 'Internal Server Error',
        status: 500,
        detail: 'The page is unavailable.',
      }),
    };
  }

  return {
    statusCode: 200,
    headers: buildHeaders(
      nonce,
      env('CONTENT_SECURITY_POLICY', DEFAULT_CONTENT_SECURITY_POLICY),
      JSON.parse(env('ADDITIONAL_HEADERS', '{}')) as Record<string, string>,
    ),
    body: injectNonce(html, nonce, env('NONCE_TOKEN', DEFAULT_NONCE_TOKEN)),
    isBase64Encoded: false,
  };
}
