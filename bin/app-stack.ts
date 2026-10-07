import * as path from 'node:path';
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { LambdaIntegration } from 'aws-cdk-lib/aws-apigateway';
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { SpaApiGateway } from 'cdk-spa-api-gateway';
import { VpcBackend } from './vpc-backend';

export interface AppStackProps extends StackProps {
  /**
   * Proxy `/api` to a small EC2 instance behind an NLB and a VPC link, which costs money.
   * By default the backend is a public URL, which does not.
   */
  readonly vpcBackend?: boolean;
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

    // A route of your own under /api, served by a Lambda instead of the backend: a JWKS endpoint would go here.
    // It has no authorizer, as a public key set is meant to be public.
    const jwksFunction = new LambdaFunction(this, 'JwksFunction', {
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
    this.spa.apiResource
      .addResource('v1')
      .addResource('auth')
      .addResource('jwks')
      .addMethod('GET', new LambdaIntegration(jwksFunction));

    new BucketDeployment(this, 'SiteDeployment', {
      sources: [Source.asset(path.join(__dirname, 'site'))],
      destinationBucket: bucket,
    });

    new CfnOutput(this, 'Url', { value: this.spa.api.url });
  }
}
