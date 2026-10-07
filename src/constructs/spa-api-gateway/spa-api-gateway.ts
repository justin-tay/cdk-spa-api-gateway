import * as path from 'node:path';
import { Duration } from 'aws-cdk-lib';
import {
  AccessLogFormat,
  AwsIntegration,
  ContentHandling,
  ConnectionType,
  HttpIntegration,
  LambdaIntegration,
  LogGroupLogDestination,
  PassthroughBehavior,
  ResponseType,
  RestApi,
  type IResource,
  type Integration,
  type IntegrationResponse,
  type MethodResponse,
} from 'aws-cdk-lib/aws-apigateway';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  LoggingFormat,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DEFAULT_NONCE_TOKEN } from '../../assets/lambda/index-html';
import { PROBLEM_CONTENT_TYPE, problemJson, type ProblemDetails } from '../../assets/lambda/problem-details';
import type { SpaApiGatewayProps } from './spa-api-gateway-props';

// src/ and lib/ sit at the same depth, so this resolves to the bundle under
// lib/ both from the compiled construct and from the TypeScript source in tests.
const INDEX_PAGE_HANDLER_ASSET_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'lib',
  'assets',
  'lambda',
  'handlers',
  'index-page',
);

const DEFAULT_STATIC_PATHS = ['/assets/{proxy+}'];
const DEFAULT_STATIC_FILES = [
  '/favicon.svg',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/sw.js',
  '/robots.txt',
];

/** Files that must be revalidated on every load, so that an update is picked up promptly. */
const NO_CACHE_FILES = new Set(['/sw.js', '/manifest.webmanifest']);

const PROXY = '{proxy+}';
/** The key API Gateway files a mapping template under; the body is sent as problem+json regardless. */
const TEMPLATE_KEY = 'application/json';

/** An S3 error status, as API Gateway sees it, and the problem it is mapped to. */
interface ErrorMapping {
  readonly selectionPattern: string;
  readonly problem: ProblemDetails;
}

// The patterns do not overlap, so which one matches is never ambiguous.
// S3 answers 403 rather than 404 for a missing key when the caller cannot list the bucket.
const S3_ERROR_MAPPINGS: readonly ErrorMapping[] = [
  {
    selectionPattern: '403|404',
    problem: { title: 'Not Found', status: 404, detail: 'The requested resource was not found.' },
  },
  {
    selectionPattern: '4(0[0-25-9]|[1-9][0-9])',
    problem: { title: 'Bad Request', status: 400, detail: 'The request could not be processed.' },
  },
  {
    selectionPattern: '5[0-9]{2}',
    problem: { title: 'Bad Gateway', status: 502, detail: 'The resource is temporarily unavailable.' },
  },
];

/**
 * The errors API Gateway itself raises, answered as problems. `status` is the status API Gateway
 * uses for the type, which is left as it is. The remaining 4xx and 5xx get a problem without one.
 */
const GATEWAY_ERRORS: ReadonlyArray<readonly [ResponseType, ProblemDetails]> = [
  [ResponseType.UNAUTHORIZED, { title: 'Unauthorized', status: 401, detail: 'Authentication is required.' }],
  [ResponseType.ACCESS_DENIED, { title: 'Forbidden', status: 403, detail: 'Access is denied.' }],
  [
    ResponseType.MISSING_AUTHENTICATION_TOKEN,
    { title: 'Forbidden', status: 403, detail: 'The request is not allowed for this resource.' },
  ],
  [
    ResponseType.RESOURCE_NOT_FOUND,
    { title: 'Not Found', status: 404, detail: 'The requested resource was not found.' },
  ],
  [
    ResponseType.REQUEST_TOO_LARGE,
    { title: 'Content Too Large', status: 413, detail: 'The request is too large.' },
  ],
  [
    ResponseType.UNSUPPORTED_MEDIA_TYPE,
    { title: 'Unsupported Media Type', status: 415, detail: 'The media type is not supported.' },
  ],
  [
    ResponseType.THROTTLED,
    { title: 'Too Many Requests', status: 429, detail: 'Too many requests. Try again later.' },
  ],
  [
    ResponseType.QUOTA_EXCEEDED,
    { title: 'Too Many Requests', status: 429, detail: 'The quota is exceeded.' },
  ],
  [
    ResponseType.INTEGRATION_FAILURE,
    { title: 'Bad Gateway', status: 502, detail: 'The backend could not be reached.' },
  ],
  [
    ResponseType.INTEGRATION_TIMEOUT,
    { title: 'Gateway Timeout', status: 504, detail: 'The backend did not answer in time.' },
  ],
];
const GATEWAY_FALLBACKS: ReadonlyArray<readonly [ResponseType, Omit<ProblemDetails, 'status'>]> = [
  [ResponseType.DEFAULT_4XX, { title: 'Client Error', detail: 'The request could not be processed.' }],
  [ResponseType.DEFAULT_5XX, { title: 'Server Error', detail: 'The request could not be completed.' }],
];

/**
 * Serves a single-page app from an API Gateway REST API:
 *
 * - the HTML (`/`, `/index.html` and, by default, every unmatched path) comes from a Lambda that
 *   injects a CSP nonce and security headers
 * - static assets come straight from S3, with S3 errors mapped to problem details (RFC 9457)
 * - `/api/{proxy+}` is proxied to a backend
 */
export class SpaApiGateway extends Construct {
  public readonly api: RestApi;

  public readonly bucket: IBucket;

  public readonly indexFunction: LambdaFunction;

  /**
   * The `/api` resource. Add your own routes under it, e.g. `apiResource.addResource('auth')`: a route is
   * more specific than the `/api/{proxy+}` backend proxy, so it is served instead of the backend.
   * `apiAuthorizer` covers only the proxy; set an authorizer on a route you add yourself.
   */
  public readonly apiResource: IResource;

  private readonly s3Role: Role;

  constructor(scope: Construct, id: string, props: SpaApiGatewayProps) {
    super(scope, id);

    this.bucket =
      props.bucket ??
      new Bucket(this, 'Bucket', {
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        encryption: BucketEncryption.S3_MANAGED,
        enforceSSL: true,
      });
    const logRetention = props.logRetention ?? RetentionDays.ONE_WEEK;

    this.indexFunction = new LambdaFunction(this, 'IndexFunction', {
      description: 'Serves index.html with a CSP nonce and security headers',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: Code.fromAsset(INDEX_PAGE_HANDLER_ASSET_PATH),
      memorySize: 128,
      timeout: Duration.seconds(10),
      environment: {
        BUCKET_NAME: this.bucket.bucketName,
        NONCE_TOKEN: props.nonceToken ?? DEFAULT_NONCE_TOKEN,
        ...(props.contentSecurityPolicy && { CONTENT_SECURITY_POLICY: props.contentSecurityPolicy }),
        ...(props.additionalHeaders && { ADDITIONAL_HEADERS: JSON.stringify(props.additionalHeaders) }),
      },
      logGroup: new LogGroup(this, 'IndexFunctionLogGroup', { retention: logRetention }),
      loggingFormat: LoggingFormat.TEXT,
    });
    this.indexFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects('index.html')],
      }),
    );

    this.api = new RestApi(this, 'Api', {
      description: 'Serves a single-page app and proxies its backend API',
      // The static assets include fonts and images, which must pass through as binary.
      binaryMediaTypes: ['*/*'],
      cloudWatchRole: false,
      deployOptions: props.accessLogging
        ? {
            accessLogDestination: new LogGroupLogDestination(
              new LogGroup(this, 'AccessLogGroup', { retention: logRetention }),
            ),
            accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
          }
        : undefined,
    });

    this.s3Role = new Role(this, 'S3Role', {
      assumedBy: new ServicePrincipal('apigateway.amazonaws.com'),
    });
    // ListBucket makes S3 answer 404 rather than 403 for a missing key.
    this.s3Role.addToPolicy(
      new PolicyStatement({ actions: ['s3:GetObject'], resources: [this.bucket.arnForObjects('*')] }),
    );
    this.s3Role.addToPolicy(
      new PolicyStatement({ actions: ['s3:ListBucket'], resources: [this.bucket.bucketArn] }),
    );

    const indexIntegration = new LambdaIntegration(this.indexFunction, { proxy: true });
    this.api.root.addMethod('GET', indexIntegration);
    this.api.root.addResource('index.html').addMethod('GET', indexIntegration);

    for (const staticPath of props.staticPaths ?? DEFAULT_STATIC_PATHS) {
      this.addStaticPath(staticPath);
    }
    for (const staticFile of props.staticFiles ?? DEFAULT_STATIC_FILES) {
      this.addStaticFile(staticFile);
    }

    this.apiResource = this.addBackend(props);
    this.addGatewayResponses();

    // API Gateway picks the most specific resource, so this catch-all only gets what nothing else does.
    if (props.spaFallback ?? true) {
      this.api.root.addResource(PROXY).addMethod('GET', indexIntegration, {
        requestParameters: { 'method.request.path.proxy': true },
      });
    } else {
      this.addStaticPath(`/${PROXY}`);
    }
  }

  /** `/assets/{proxy+}` serves the objects under `assets/`; `/{proxy+}` serves the whole bucket. */
  private addStaticPath(staticPath: string): void {
    if (!staticPath.endsWith(`/${PROXY}`)) {
      throw new Error(
        `A static path must end in "/${PROXY}", got "${staticPath}"; use staticFiles for a file`,
      );
    }
    const prefix = staticPath.slice(1, -PROXY.length);
    this.addS3Methods(this.api.root.resourceForPath(staticPath), `${prefix}{proxy}`, {
      requestParameters: { 'integration.request.path.proxy': 'method.request.path.proxy' },
      methodParameters: { 'method.request.path.proxy': true },
    });
  }

  /** A single object at a fixed path, e.g. `/favicon.svg`. */
  private addStaticFile(staticFile: string): void {
    if (!staticFile.startsWith('/') || staticFile.includes('{')) {
      throw new Error(`A static file must be an absolute path without parameters, got "${staticFile}"`);
    }
    this.addS3Methods(this.api.root.resourceForPath(staticFile), staticFile.slice(1), {
      noCache: NO_CACHE_FILES.has(staticFile),
    });
  }

  private addS3Methods(
    resource: IResource,
    key: string,
    options: {
      requestParameters?: Record<string, string>;
      methodParameters?: Record<string, boolean>;
      noCache?: boolean;
    },
  ): void {
    for (const httpMethod of ['GET', 'HEAD']) {
      resource.addMethod(httpMethod, this.s3Integration(httpMethod, key, options), {
        requestParameters: options.methodParameters,
        methodResponses: s3MethodResponses(),
      });
    }
  }

  private s3Integration(
    httpMethod: string,
    key: string,
    options: { requestParameters?: Record<string, string>; noCache?: boolean },
  ): Integration {
    const successHeaders: Record<string, string> = {
      'method.response.header.Content-Type': 'integration.response.header.Content-Type',
      'method.response.header.ETag': 'integration.response.header.ETag',
      'method.response.header.Last-Modified': 'integration.response.header.Last-Modified',
      'method.response.header.Cache-Control': options.noCache
        ? "'no-cache'"
        : 'integration.response.header.Cache-Control',
    };
    const integrationResponses: IntegrationResponse[] = [
      { statusCode: '200', responseParameters: successHeaders },
      ...S3_ERROR_MAPPINGS.map(({ selectionPattern, problem }): IntegrationResponse => ({
        selectionPattern,
        statusCode: String(problem.status),
        responseParameters: { 'method.response.header.Content-Type': `'${PROBLEM_CONTENT_TYPE}'` },
        // With binary media types of `*/*`, a response would otherwise be passed through as binary and
        // S3's XML error would reach the browser instead of this template.
        contentHandling: ContentHandling.CONVERT_TO_TEXT,
        responseTemplates: { [TEMPLATE_KEY]: problemJson(problem) },
      })),
    ];

    return new AwsIntegration({
      service: 's3',
      integrationHttpMethod: httpMethod,
      path: `${this.bucket.bucketName}/${key}`,
      options: {
        credentialsRole: this.s3Role,
        passthroughBehavior: PassthroughBehavior.WHEN_NO_MATCH,
        requestParameters: options.requestParameters,
        integrationResponses,
      },
    });
  }

  /**
   * The errors API Gateway raises itself (throttling, timeouts, unknown routes, ...), as problem details.
   * API Gateway ignores a `Content-Type` header set on a gateway response and instead answers with the
   * template key that matches the client's `Accept`. So the body is filed under both: a client that sends
   * `Accept: application/problem+json` gets that media type, any other gets `application/json`.
   */
  private addGatewayResponses(): void {
    for (const [type, problem] of GATEWAY_ERRORS) {
      this.api.addGatewayResponse(`${type.responseType}Problem`, {
        type,
        templates: { [TEMPLATE_KEY]: problemJson(problem), [PROBLEM_CONTENT_TYPE]: problemJson(problem) },
      });
    }
    for (const [type, problem] of GATEWAY_FALLBACKS) {
      this.api.addGatewayResponse(`${type.responseType}Problem`, {
        type,
        templates: { [TEMPLATE_KEY]: JSON.stringify(problem) },
      });
    }
  }

  /** `/api` and `/api/{proxy+}`, proxied to the backend. Returns the `/api` resource. */
  private addBackend(props: SpaApiGatewayProps): IResource {
    const { backend } = props;
    const baseUrl = backend.url.replace(/\/+$/, '');
    const options = {
      connectionType: backend.vpcLink ? ConnectionType.VPC_LINK : ConnectionType.INTERNET,
      vpcLink: backend.vpcLink,
    };
    const hostParameters: Record<string, string> = backend.hostHeader
      ? { 'integration.request.header.Host': `'${backend.hostHeader}'` }
      : {};
    const methodOptions = { authorizer: props.apiAuthorizer };

    const apiResource = this.api.root.addResource('api');
    apiResource.addMethod(
      'ANY',
      new HttpIntegration(baseUrl, {
        httpMethod: 'ANY',
        proxy: true,
        options: { ...options, requestParameters: hostParameters },
      }),
      methodOptions,
    );
    apiResource.addResource(PROXY).addMethod(
      'ANY',
      new HttpIntegration(`${baseUrl}/{proxy}`, {
        httpMethod: 'ANY',
        proxy: true,
        options: {
          ...options,
          requestParameters: {
            'integration.request.path.proxy': 'method.request.path.proxy',
            ...hostParameters,
          },
        },
      }),
      { ...methodOptions, requestParameters: { 'method.request.path.proxy': true } },
    );
    return apiResource;
  }
}

/** The method response headers: each is declared, so the integration response may set it. */
function responseHeaders(names: string[]): Record<string, boolean> {
  return Object.fromEntries(names.map((name) => [`method.response.header.${name}`, true]));
}

function s3MethodResponses(): MethodResponse[] {
  return [
    {
      statusCode: '200',
      responseParameters: responseHeaders(['Content-Type', 'ETag', 'Last-Modified', 'Cache-Control']),
    },
    ...S3_ERROR_MAPPINGS.map(({ problem }) => ({
      statusCode: String(problem.status),
      responseParameters: responseHeaders(['Content-Type']),
    })),
  ];
}
