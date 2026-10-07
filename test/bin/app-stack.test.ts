import { App, Duration } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AppStack, type AppStackProps } from '../../bin/app-stack';

const SECRET_ARN = 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:jwks-AbCdEf';
const ENC_SECRET_ARN = 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:jwks-enc-GhIjKl';

function synth(props: AppStackProps = {}): Template {
  return Template.fromStack(new AppStack(new App(), 'Example', props));
}

test('proxies /api to a public URL by default, with no VPC, NLB or instance to pay for', () => {
  const template = synth();

  template.resourceCountIs('AWS::EC2::VPC', 0);
  template.resourceCountIs('AWS::EC2::Instance', 0);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  template.resourceCountIs('AWS::ApiGateway::VpcLink', 0);
});

test('deploys the sample site to the bucket', () => {
  const template = synth();

  template.resourceCountIs('Custom::CDKBucketDeployment', 1);
});

test('can proxy /api to an instance behind an NLB and a VPC link', () => {
  const template = synth({ vpcBackend: true });

  template.resourceCountIs('AWS::EC2::Instance', 1);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  template.resourceCountIs('AWS::ApiGateway::VpcLink', 1);
});

test('serves a route of its own under /api from a Lambda, which wins over the backend proxy', () => {
  const template = synth();

  const resources = Object.values(template.findResources('AWS::ApiGateway::Resource')) as any[];
  expect(resources.map(({ Properties }) => Properties.PathPart)).toEqual(
    expect.arrayContaining(['api', '{proxy+}', 'v1', 'auth', 'jwks']),
  );
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'GET',
    AuthorizationType: 'NONE',
    Integration: { Type: 'AWS_PROXY' },
  });
});

describe('JWKS endpoint', () => {
  it('serves an empty key set from a placeholder when no secret is given', () => {
    const template = synth();

    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Code: { ZipFile: Match.stringLikeRegexp('keys: ') },
    });
    // Nothing may read a secret, as there is none.
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
    expect(JSON.stringify(policies)).not.toContain('secretsmanager:');
  });

  it('serves the public keys of the secret when its ARN is given', () => {
    const template = synth({ jwksSecretArns: [SECRET_ARN], jwksCacheTtl: Duration.seconds(300) });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: { JWKS_SECRET_ARNS: JSON.stringify([SECRET_ARN]), JWKS_CACHE_SECONDS: '300' },
      },
    });
    // The secret already exists, so it is imported, not created.
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });

  it("lets the endpoint's own role read that secret, and only that one", () => {
    const template = synth({ jwksSecretArns: [SECRET_ARN] });

    const roleId = Object.keys(template.findResources('AWS::IAM::Role')).find((id) =>
      id.includes('JwksEndpoint'),
    );
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
            Effect: 'Allow',
            Resource: SECRET_ARN,
          },
        ]),
      },
      Roles: [{ Ref: roleId }],
    });
    // No wildcard access to secrets anywhere.
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('secretsmanager:*');
  });

  it('serves the keys of several secrets, and lets the role read each of them and no others', () => {
    const template = synth({ jwksSecretArns: [SECRET_ARN, ENC_SECRET_ARN] });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ JWKS_SECRET_ARNS: JSON.stringify([SECRET_ARN, ENC_SECRET_ARN]) }),
      },
    });
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain(SECRET_ARN);
    expect(policies).toContain(ENC_SECRET_ARN);
    expect(policies).not.toContain('secretsmanager:*');
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });

  it('serves the placeholder for an empty list', () => {
    const template = synth({ jwksSecretArns: [] });

    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('secretsmanager:');
  });

  it('keeps the route and the missing authorizer: a JWKS is public', () => {
    const template = synth({ jwksSecretArns: [SECRET_ARN] });

    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
      Integration: { Type: 'AWS_PROXY' },
    });
  });
});
