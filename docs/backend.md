# The `/api` backend

`/api` and `/api/{proxy+}` are proxied with an API Gateway HTTP proxy integration, for every HTTP method. The request, including headers and body, is passed through, and so is the response.

```ts
new SpaApiGateway(this, 'Spa', {
  backend: { url: 'https://api.example.com' },
});
```

## Paths

`/api` is mounted at the `url`: whatever follows `/api` in the browser's request is appended to it. The URL says exactly where the traffic goes, scheme included, and a trailing slash is ignored.

| `url`                         | `GET /api/users` reaches            |
| ----------------------------- | ----------------------------------- |
| `https://api.example.com/api` | `https://api.example.com/api/users` |
| `https://api.example.com`     | `https://api.example.com/users`     |
| `https://api.example.com/v1`  | `https://api.example.com/v1/users`  |

A backend that serves under `/api` therefore needs `url: 'https://api.example.com/api'`. API versions (`/api/v1`, `/api/v2`) are the backend's concern; nothing in the gateway needs to change when one is added. (The stage name in the default execute-api URL, such as `/prod`, is removed by API Gateway before this and is never sent to the backend.)

## A public website

Any public HTTPS URL works, including a third party's. Things to know:

- API Gateway sends the target's host in the `Host` header, so a virtual-hosted site sees its own name. Override it with `backend.hostHeader` if the backend expects another.
- The backend's certificate must chain to a public CA.
- A response is limited to 10 MB and the default integration timeout is 29 seconds.
- A `3xx` response passes back to the browser as it is, so a `Location` to another site leaves your origin.

## A private backend through a VPC link

Pass a `VpcLink` and the URL of the load balancer behind it:

```ts
const nlb = new NetworkLoadBalancer(this, 'Nlb', { vpc, internetFacing: false });
// ... add a listener and targets

new SpaApiGateway(this, 'Spa', {
  backend: {
    url: `http://${nlb.loadBalancerDnsName}`,
    vpcLink: new VpcLink(this, 'VpcLink', { targets: [nlb] }),
  },
});
```

A REST API VPC link targets a Network Load Balancer, so an EC2 instance needs an NLB in front of it. An NLB with one instance is the cheapest setup: a Network Load Balancer costs about the same per hour as an Application Load Balancer, and its usage charge is lower, while the VPC link itself is free. Use an ALB only if the backend already sits behind one or you need its routing or WAF. The sample stack builds the NLB setup with `npx cdk deploy -c vpcBackend=true`; it runs an instance in an isolated subnet with no NAT gateway, and you pay for the instance and the NLB while it exists.

The `Host` header API Gateway sends comes from the integration URI, which here is the NLB's DNS name. If the backend depends on its own hostname, set `hostHeader`.

## Authentication

By default the construct adds none: `Authorization` and every other header reach the backend, which decides. To reject unauthenticated requests at the gateway instead, pass any CDK authorizer:

```ts
apiAuthorizer: new CognitoUserPoolsAuthorizer(this, 'Authorizer', { cognitoUserPools: [pool] }),
```

It applies to the `/api` methods only. The HTML and the static assets stay public, since the browser must be able to load the app before it can sign in. Allow CORS preflight if the app calls `/api` from another origin; calls from the same origin, which is the point of this construct, need no CORS.

## Your own routes under `/api`

`spa.apiResource` is the `/api` resource. A route you add under it is more specific than the `/api/{proxy+}` proxy, so API Gateway serves it and the backend never sees the request; every other `/api/...` path still goes to the backend.

```ts
spa.apiResource
  .addResource('v1')
  .addResource('auth')
  .addResource('jwks')
  .addMethod('GET', new LambdaIntegration(jwksFunction)); // /api/v1/auth/jwks
```

`apiAuthorizer` covers only the backend proxy. A route you add has no authorizer unless you pass one to `addMethod`, which is what you want for a public JWKS. The sample stack in [`bin/`](../bin/app-stack.ts) adds such a route; see below.

### The JWKS sample

By default the sample route is a placeholder that serves `{"keys":[]}` and creates nothing extra. Pass the secrets to serve and the route becomes a real endpoint (`bin/handlers/jwks-endpoint.ts`) that serves their public keys:

```bash
# one secret
npx cdk deploy -c jwksSecretArns=arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:sig-AbCdEf

# several, comma-separated and with no spaces: their keys are served together
npx cdk deploy -c jwksSecretArns=<sig secret arn>,<enc secret arn> -c jwksCacheSeconds=300
```

- **Use complete ARNs**, including the random suffix (`-AbCdEf`). A name or partial ARN gives an IAM policy that does not match the secret, and the endpoint fails with access denied. Get it with `aws secretsmanager describe-secret --secret-id <name> --query ARN --output text`, and use the region you deploy to.
- **The endpoint's own role** may read each of those secrets (`secretsmanager:GetSecretValue`, `DescribeSecret`) and no others.
- **A secret encrypted with a customer managed key** also needs `kms:Decrypt` on that key for the endpoint's role. The ARN does not say which key it is, so the sample does not grant it.
- **`jwksCacheSeconds`** caches each secret in the function and sets `Cache-Control: public, max-age=<n>`. The default is `0`: no caching, and `no-cache`. An empty key set, as before the first rotation, is never cached.
- The handler serves every `sig` key, drops the oldest `enc` key once there are three, and never serves a private member. It checks only that a secret is `{"keys":[...]}`; whatever writes the secret is responsible for the keys being valid.
