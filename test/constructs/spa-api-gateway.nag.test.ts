import { App, Stack, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SpaApiGateway } from '../../src/constructs';

// What is left after the construct's own choices is by design: it serves a public
// site, and the defaults leave out what costs money. A consumer decides these.
const BY_DESIGN = [
  [
    'AwsSolutions-APIG1',
    'Access logging is opt-in (accessLogging): it needs an account-level CloudWatch role.',
  ],
  ['AwsSolutions-APIG2', 'Requests are proxied or served as-is; there is no request body to validate.'],
  ['AwsSolutions-APIG3', 'A WAF costs money, so it is not a default; attach one to the stage.'],
  [
    'AwsSolutions-APIG4',
    'The site and its assets are public; /api is authorized by the backend or apiAuthorizer.',
  ],
  ['AwsSolutions-APIG6', 'Stage logging is opt-in, together with access logging.'],
  [
    'AwsSolutions-COG4',
    'The site and its assets are public; /api is authorized by the backend or apiAuthorizer.',
  ],
  ['AwsSolutions-S1', 'Server access logs cost money; the bucket is private and read through the API only.'],
  [
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    'The managed policy only lets the function write its own logs.',
  ],
  [
    'AwsSolutions-IAM5[Resource::<SpaBucket49E09520.Arn>/*]',
    'The API serves any object under the paths it is given, so it may read any object in the bucket.',
  ],
] as const;

test('the defaults pass the AWS Solutions cdk-nag checks, but for what is by design', () => {
  const app = new App();
  const stack = new Stack(app, 'NagStack');
  new SpaApiGateway(stack, 'Spa', { backend: { url: 'https://example.com' } });
  for (const [id, reason] of BY_DESIGN) {
    Validations.of(stack).acknowledge({ id: `AwsSolutions::${id}`, reason });
  }
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));

  expect(() => app.synth()).not.toThrow();
});
