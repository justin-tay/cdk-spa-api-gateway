import { App, Duration } from 'aws-cdk-lib';
import { AppStack } from './app-stack';

const app = new App();

// e.g. npx cdk deploy -c vpcBackend=true
//      npx cdk deploy -c jwksSecretArns=arn:aws:secretsmanager:...:secret:a-AbCdEf,arn:...:secret:b-GhIjKl -c jwksCacheSeconds=300
// A comma-separated list: context values are strings.
const jwksSecretArns: string[] = String(app.node.tryGetContext('jwksSecretArns') ?? '')
  .split(',')
  .map((arn) => arn.trim())
  .filter((arn) => arn.length > 0);
const jwksCacheSeconds: string | undefined = app.node.tryGetContext('jwksCacheSeconds');

new AppStack(app, 'SpaApiGatewayExampleApp', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  vpcBackend: app.node.tryGetContext('vpcBackend') === 'true',
  jwksSecretArns,
  jwksCacheTtl: jwksCacheSeconds === undefined ? undefined : Duration.seconds(Number(jwksCacheSeconds)),
});
