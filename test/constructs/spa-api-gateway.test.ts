import { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcLink } from 'aws-cdk-lib/aws-apigateway';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { NetworkLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { SpaApiGateway, type SpaApiGatewayProps } from 'cdk-spa-api-gateway';

function create(props: Partial<SpaApiGatewayProps> = {}): Template {
  const stack = new Stack();
  new SpaApiGateway(stack, 'Spa', { backend: { url: 'https://example.com' }, ...props });
  return Template.fromStack(stack);
}

/** The path of every API Gateway resource, e.g. `/assets/{proxy+}`, mapped to its logical id. */
function resourcePaths(template: Template): Map<string, string> {
  const resources = template.findResources('AWS::ApiGateway::Resource');
  const pathOf = (logicalId: string): string => {
    const { ParentId, PathPart } = resources[logicalId].Properties;
    return `${ParentId.Ref ? pathOf(ParentId.Ref) : ''}/${PathPart}`;
  };
  return new Map(Object.keys(resources).map((logicalId) => [pathOf(logicalId), logicalId]));
}

/** The properties of the method on a resource path, `/` being the root. */
function methodOf(template: Template, resourcePath: string, httpMethod: string): any {
  const logicalId = resourcePaths(template).get(resourcePath);
  const methods = Object.values(
    template.findResources('AWS::ApiGateway::Method', { Properties: { HttpMethod: httpMethod } }),
  ).filter(({ Properties }: any) =>
    resourcePath === '/'
      ? Properties.ResourceId['Fn::GetAtt']?.[1] === 'RootResourceId'
      : Properties.ResourceId.Ref === logicalId,
  );
  expect(methods).toHaveLength(1);
  return (methods[0] as any).Properties;
}

describe('SpaApiGateway', () => {
  it('creates a private, encrypted bucket by default', () => {
    create().hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, RestrictPublicBuckets: true },
    });
  });

  it('uses the bucket it is given', () => {
    const stack = new Stack();
    new SpaApiGateway(stack, 'Spa', {
      backend: { url: 'https://example.com' },
      bucket: new Bucket(stack, 'Mine'),
    });

    Template.fromStack(stack).resourceCountIs('AWS::S3::Bucket', 1);
  });

  it('passes everything through as binary and does not touch the account', () => {
    const template = create();

    template.hasResourceProperties('AWS::ApiGateway::RestApi', { BinaryMediaTypes: ['*/*'] });
    template.resourceCountIs('AWS::ApiGateway::Account', 0);
  });

  it('runs a small arm64 Lambda with a short log retention', () => {
    const template = create();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      MemorySize: 128,
      Environment: { Variables: { NONCE_TOKEN: '__CSP_NONCE__' } },
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  it('passes the token, the CSP and extra headers to the Lambda', () => {
    create({
      nonceToken: '@@NONCE@@',
      contentSecurityPolicy: "script-src 'nonce-{nonce}'",
      additionalHeaders: { 'X-Frame-Options': 'DENY' },
    }).hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          NONCE_TOKEN: '@@NONCE@@',
          CONTENT_SECURITY_POLICY: "script-src 'nonce-{nonce}'",
          ADDITIONAL_HEADERS: '{"X-Frame-Options":"DENY"}',
        },
      },
    });
  });

  describe('routes', () => {
    it('serves /, /index.html and everything else from the Lambda', () => {
      const template = create();

      for (const resourcePath of ['/', '/index.html', '/{proxy+}']) {
        expect(methodOf(template, resourcePath, 'GET').Integration).toMatchObject({ Type: 'AWS_PROXY' });
      }
    });

    it('serves /assets and the static files from S3 with GET and HEAD', () => {
      const template = create();

      for (const resourcePath of ['/assets/{proxy+}', '/favicon.svg', '/manifest.webmanifest', '/sw.js']) {
        for (const httpMethod of ['GET', 'HEAD']) {
          expect(methodOf(template, resourcePath, httpMethod).Integration).toMatchObject({
            Type: 'AWS',
            IntegrationHttpMethod: httpMethod,
          });
        }
      }
    });

    it('maps a greedy static path to the matching S3 prefix', () => {
      const integration = methodOf(create(), '/assets/{proxy+}', 'GET').Integration;

      expect(JSON.stringify(integration.Uri)).toContain('/assets/{proxy}');
      expect(integration.RequestParameters).toEqual({
        'integration.request.path.proxy': 'method.request.path.proxy',
      });
    });

    it('revalidates the service worker and manifest on every load', () => {
      const template = create();

      for (const resourcePath of ['/sw.js', '/manifest.webmanifest']) {
        const [ok] = methodOf(template, resourcePath, 'GET').Integration.IntegrationResponses;
        expect(ok.ResponseParameters['method.response.header.Cache-Control']).toBe("'no-cache'");
      }
      const [favicon] = methodOf(template, '/favicon.svg', 'GET').Integration.IntegrationResponses;
      expect(favicon.ResponseParameters['method.response.header.Cache-Control']).toBe(
        'integration.response.header.Cache-Control',
      );
    });

    it('sends everything else to S3 when spaFallback is off', () => {
      const integration = methodOf(create({ spaFallback: false }), '/{proxy+}', 'GET').Integration;

      expect(integration.Type).toBe('AWS');
      expect(JSON.stringify(integration.Uri)).toContain('/{proxy}');
    });

    it('takes custom static paths and files', () => {
      const paths = resourcePaths(
        create({ staticPaths: ['/static/{proxy+}'], staticFiles: ['/.well-known/assetlinks.json'] }),
      );

      expect(paths.has('/static/{proxy+}')).toBe(true);
      expect(paths.has('/.well-known/assetlinks.json')).toBe(true);
      expect(paths.has('/assets/{proxy+}')).toBe(false);
    });

    it('rejects a static path that is not a greedy proxy', () => {
      expect(() => create({ staticPaths: ['/assets'] })).toThrow(/must end in/);
    });

    it('rejects a static file with a parameter or without a leading slash', () => {
      expect(() => create({ staticFiles: ['/assets/{id}'] })).toThrow(/without parameters/);
      expect(() => create({ staticFiles: ['sw.js'] })).toThrow(/without parameters/);
    });
  });

  describe('S3 errors', () => {
    it('matches each error status with exactly one response, and every error status with one', () => {
      const responses = methodOf(create(), '/assets/{proxy+}', 'GET').Integration.IntegrationResponses;
      const patterns: string[] = responses.flatMap((r: any) =>
        r.SelectionPattern ? [r.SelectionPattern] : [],
      );

      for (let status = 400; status <= 599; status++) {
        const matching = patterns.filter((pattern) => new RegExp(`^(${pattern})$`).test(String(status)));
        expect({ status, matches: matching.length }).toEqual({ status, matches: 1 });
      }
      expect(patterns.some((pattern) => new RegExp(`^(${pattern})$`).test('200'))).toBe(false);
    });

    it('turns the error bodies to text, so the JSON template applies despite the binary media types', () => {
      const responses = methodOf(create(), '/assets/{proxy+}', 'GET').Integration.IntegrationResponses;

      for (const response of responses.filter((r: any) => r.SelectionPattern)) {
        expect(response.ContentHandling).toBe('CONVERT_TO_TEXT');
      }
    });

    it('maps them to problem details', () => {
      const responses = methodOf(create(), '/assets/{proxy+}', 'GET').Integration.IntegrationResponses;

      expect(responses.map((r: any) => [r.SelectionPattern, r.StatusCode])).toEqual([
        [undefined, '200'],
        ['403|404', '404'],
        ['4(0[0-25-9]|[1-9][0-9])', '400'],
        ['5[0-9]{2}', '502'],
      ]);
      expect(responses[1]).toMatchObject({
        ResponseParameters: { 'method.response.header.Content-Type': "'application/problem+json'" },
        ResponseTemplates: {
          'application/json':
            '{"title":"Not Found","status":404,"detail":"The requested resource was not found."}',
        },
      });
      expect(JSON.parse(responses[2].ResponseTemplates['application/json'])).toEqual({
        title: 'Bad Request',
        status: 400,
        detail: 'The request could not be processed.',
      });
      expect(JSON.parse(responses[3].ResponseTemplates['application/json'])).toMatchObject({
        title: 'Bad Gateway',
        status: 502,
      });
    });

    it('answers the errors API Gateway raises itself as problem details too', () => {
      const template = create();
      const responses = Object.values(template.findResources('AWS::ApiGateway::GatewayResponse')) as any[];
      const byType = new Map(responses.map(({ Properties }) => [Properties.ResponseType, Properties]));

      for (const type of [
        'THROTTLED',
        'MISSING_AUTHENTICATION_TOKEN',
        'INTEGRATION_TIMEOUT',
        'DEFAULT_4XX',
        'DEFAULT_5XX',
      ]) {
        expect(JSON.parse(byType.get(type)!.ResponseTemplates['application/json'])).toHaveProperty('title');
      }
      expect(JSON.parse(byType.get('THROTTLED').ResponseTemplates['application/json'])).toEqual({
        title: 'Too Many Requests',
        status: 429,
        detail: 'Too many requests. Try again later.',
      });
      // The media type follows the template that matches the client's Accept.
      expect(new Set(Object.keys(byType.get('THROTTLED').ResponseTemplates))).toEqual(
        new Set(['application/json', 'application/problem+json']),
      );
      // A fallback does not know its status, so it has no `status` member (optional in RFC 9457).
      expect(JSON.parse(byType.get('DEFAULT_4XX').ResponseTemplates['application/json'])).toEqual({
        title: 'Client Error',
        detail: 'The request could not be processed.',
      });
      // A type keeps API Gateway's own status code.
      expect(byType.get('THROTTLED').StatusCode).toBeUndefined();
    });

    it('declares the response headers on the method', () => {
      const methodResponses = methodOf(create(), '/assets/{proxy+}', 'GET').MethodResponses;

      expect(methodResponses.map((r: any) => r.StatusCode)).toEqual(['200', '404', '400', '502']);
      expect(methodResponses[0].ResponseParameters).toMatchObject({ 'method.response.header.ETag': true });
    });

    it('lets the API role list the bucket, so a missing key is a 404 and not a 403', () => {
      create().hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Action: 's3:GetObject' }),
            Match.objectLike({ Action: 's3:ListBucket' }),
          ]),
        },
        Roles: [{ Ref: Match.stringLikeRegexp('S3Role') }],
      });
    });
  });

  describe('backend', () => {
    it('mounts /api and /api/{proxy+} at the url', () => {
      const template = create();

      expect(methodOf(template, '/api', 'ANY').Integration).toMatchObject({
        Type: 'HTTP_PROXY',
        Uri: 'https://example.com',
        ConnectionType: 'INTERNET',
      });
      const proxy = methodOf(template, '/api/{proxy+}', 'ANY');
      expect(proxy.Integration).toMatchObject({
        Type: 'HTTP_PROXY',
        Uri: 'https://example.com/{proxy}',
        RequestParameters: { 'integration.request.path.proxy': 'method.request.path.proxy' },
      });
      expect(proxy.AuthorizationType).toBe('NONE');
    });

    it('mounts /api at the path of the url, ignoring a trailing slash', () => {
      const template = create({ backend: { url: 'https://example.com/api/' } });

      expect(methodOf(template, '/api', 'ANY').Integration.Uri).toBe('https://example.com/api');
      expect(methodOf(template, '/api/{proxy+}', 'ANY').Integration.Uri).toBe(
        'https://example.com/api/{proxy}',
      );
    });

    it('overrides the Host header', () => {
      const template = create({ backend: { url: 'https://example.com', hostHeader: 'app.example.com' } });

      expect(methodOf(template, '/api/{proxy+}', 'ANY').Integration.RequestParameters).toMatchObject({
        'integration.request.header.Host': "'app.example.com'",
      });
      expect(methodOf(template, '/api', 'ANY').Integration.RequestParameters).toEqual({
        'integration.request.header.Host': "'app.example.com'",
      });
    });

    it('goes through a VPC link', () => {
      const stack = new Stack();
      const nlb = new NetworkLoadBalancer(stack, 'Nlb', { vpc: new Vpc(stack, 'Vpc') });
      new SpaApiGateway(stack, 'Spa', {
        backend: { url: 'http://internal.example', vpcLink: new VpcLink(stack, 'Link', { targets: [nlb] }) },
      });

      expect(methodOf(Template.fromStack(stack), '/api/{proxy+}', 'ANY').Integration).toMatchObject({
        ConnectionType: 'VPC_LINK',
      });
    });
  });

  describe('apiResource', () => {
    it('is the /api resource, so a route can be added under it', () => {
      const stack = new Stack();
      const spa = new SpaApiGateway(stack, 'Spa', { backend: { url: 'https://example.com' } });
      spa.apiResource.addResource('auth').addMethod('GET');

      const template = Template.fromStack(stack);
      expect(spa.apiResource.path).toBe('/api');
      expect(resourcePaths(template).has('/api/auth')).toBe(true);
      expect(resourcePaths(template).has('/api/{proxy+}')).toBe(true);
    });
  });

  describe('access logging', () => {
    it('is off by default', () => {
      create().hasResourceProperties('AWS::ApiGateway::Stage', { AccessLogSetting: Match.absent() });
    });

    it('can be turned on', () => {
      create({ accessLogging: true }).hasResourceProperties('AWS::ApiGateway::Stage', {
        AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
      });
    });
  });
});
