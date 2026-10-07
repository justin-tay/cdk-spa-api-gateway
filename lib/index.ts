// import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface CdkSpaApiGatewayProps {
  // Define construct properties here
}

export class CdkSpaApiGateway extends Construct {

  constructor(scope: Construct, id: string, props: CdkSpaApiGatewayProps = {}) {
    super(scope, id);

    // Define construct contents here

    // example resource
    // const queue = new sqs.Queue(this, 'CdkSpaApiGatewayQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
