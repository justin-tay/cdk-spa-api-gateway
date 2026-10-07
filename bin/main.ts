import { App } from 'aws-cdk-lib';
import { AppStack } from './app-stack';

const app = new App();

// e.g. npx cdk deploy -c vpcBackend=true
new AppStack(app, 'SpaApiGatewayExampleApp', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  vpcBackend: app.node.tryGetContext('vpcBackend') === 'true',
});
