import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { LambdaIntegration } from 'aws-cdk-lib/aws-apigateway';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  type IFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { SpaApiGateway } from 'cdk-spa-api-gateway';
import { VpcBackend } from './vpc-backend';

export interface AppStackProps extends StackProps {
  /**
   * Proxy `/api` to a small EC2 instance behind an NLB and a VPC link, which costs money.
   * By default the backend is a public URL, which does not.
   */
  readonly vpcBackend?: boolean;

  /**
   * Complete ARNs (with the random suffix) of the JWKS secrets whose public keys
   * `/api/v1/auth/jwks` serves together, e.g. one of signing and one of encryption keys. The endpoint's own
   * role may read these secrets and no others. Without any, the endpoint serves an empty key set.
   */
  readonly jwksSecretArns?: readonly string[];

  /** How long the JWKS endpoint caches the secret, and its Cache-Control max-age. @default no caching */
  readonly jwksCacheTtl?: Duration;
}

/** Example of using `SpaApiGateway`, with a sample site uploaded to the bucket. */
export class AppStack extends Stack {
  public readonly spa: SpaApiGateway;

  constructor(scope: Construct, id: string, props: AppStackProps = {}) {
    super(scope, id, props);

    const bucket = new Bucket(this, 'SiteBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // An example: remove everything with the stack.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const vpcBackend = props.vpcBackend ? new VpcBackend(this, 'VpcBackend') : undefined;
    this.spa = new SpaApiGateway(this, 'Spa', {
      bucket,
      // /api is mounted at the url: restful-api.dev serves its objects at /objects, so /api/objects reaches it there.
      backend: vpcBackend ?? { url: 'https://api.restful-api.dev' },
      staticFiles: ['/favicon.svg'],
    });

    // A route of your own under /api, served by a Lambda instead of the backend. It has no authorizer,
    // as a public key set is meant to be public.
    this.spa.apiResource
      .addResource('v1')
      .addResource('auth')
      .addResource('jwks')
      .addMethod('GET', new LambdaIntegration(this.jwksFunction(props)));

    new BucketDeployment(this, 'SiteDeployment', {
      sources: [Source.asset(path.join(__dirname, 'site'))],
      destinationBucket: bucket,
    });

    new CfnOutput(this, 'Url', { value: this.spa.api.url });
  }

  /** The JWKS endpoint: the real one if a secret is given, else a placeholder serving no keys. */
  private jwksFunction({ jwksSecretArns = [], jwksCacheTtl }: AppStackProps): IFunction {
    if (jwksSecretArns.length === 0) {
      return new LambdaFunction(this, 'JwksFunction', {
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        handler: 'index.handler',
        code: Code.fromInline(
          `exports.handler = async () => ({
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
          body: JSON.stringify({ keys: [] }),
        });`,
        ),
      });
    }

    const jwksEndpoint = new NodejsFunction(this, 'JwksEndpoint', {
      description: 'Serves the public keys of the JWKS secrets',
      entry: path.join(__dirname, 'handlers', 'jwks-endpoint.ts'),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      environment: {
        JWKS_SECRET_ARNS: this.toJsonString(jwksSecretArns),
        JWKS_CACHE_SECONDS: String((jwksCacheTtl ?? Duration.seconds(0)).toSeconds()),
      },
      logGroup: new LogGroup(this, 'JwksEndpointLogGroup', {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // The function's own role may read these secrets and no others. A secret encrypted with a customer
    // managed key also needs kms:Decrypt on that key, which an ARN alone does not tell us.
    jwksSecretArns.forEach((arn, index) => {
      Secret.fromSecretCompleteArn(this, `JwksSecret${index}`, arn).grantRead(jwksEndpoint);
    });
    return jwksEndpoint;
  }
}
