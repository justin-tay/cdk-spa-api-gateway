import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../../bin/app-stack';

function synth(vpcBackend?: boolean): Template {
  return Template.fromStack(new AppStack(new App(), 'Example', { vpcBackend }));
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
  const template = synth(true);

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
