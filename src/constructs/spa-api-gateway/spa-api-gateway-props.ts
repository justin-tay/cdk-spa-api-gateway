import type { IAuthorizer, VpcLink } from 'aws-cdk-lib/aws-apigateway';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';

/** The backend that `/api/{proxy+}` is proxied to. */
export interface SpaApiBackend {
  /**
   * Where `/api` is mounted, including the scheme: `/api/users` reaches `<url>/users`. A public HTTPS site, or the
   * load balancer behind `vpcLink`. A backend that serves under `/api` needs `https://example.com/api`.
   */
  readonly url: string;

  /** Reach the backend through a VPC link (an NLB target). Not used by default: it costs money. */
  readonly vpcLink?: VpcLink;

  /** Override the `Host` header sent to the backend, which otherwise comes from `url`. */
  readonly hostHeader?: string;
}

export interface SpaApiGatewayProps {
  /** The backend for `/api/{proxy+}`. */
  readonly backend: SpaApiBackend;

  /** Bucket holding `index.html` and the static assets. A private, SSE-S3 encrypted bucket is created if omitted. */
  readonly bucket?: IBucket;

  /** Static path patterns served from S3. @default ['/assets/{proxy+}'] */
  readonly staticPaths?: string[];

  /** Static root files served from S3. @default favicon, manifest, service worker and robots.txt */
  readonly staticFiles?: string[];

  /** Serve `index.html` (with nonce) for every other path, so client-side routing works. If false, `/{proxy+}` goes to S3. @default true */
  readonly spaFallback?: boolean;

  /** Placeholder in `index.html` replaced by the per-request nonce. @default '__CSP_NONCE__' */
  readonly nonceToken?: string;

  /** Content-Security-Policy template; `{nonce}` is replaced by the nonce. */
  readonly contentSecurityPolicy?: string;

  /** Extra or overriding response headers for the HTML. */
  readonly additionalHeaders?: Record<string, string>;

  /** Authorizer applied to the `/api` methods. @default none, the backend authenticates */
  readonly apiAuthorizer?: IAuthorizer;

  /** Write API access logs to CloudWatch Logs. Needs the account-level API Gateway CloudWatch role. @default false */
  readonly accessLogging?: boolean;

  /** Retention of the Lambda and access log groups. @default RetentionDays.ONE_WEEK */
  readonly logRetention?: RetentionDays;
}
