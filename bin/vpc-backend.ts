import {
  Vpc,
  SubnetType,
  Instance,
  InstanceType,
  InstanceClass,
  InstanceSize,
  MachineImage,
  AmazonLinuxCpuType,
  UserData,
} from 'aws-cdk-lib/aws-ec2';
import { NetworkLoadBalancer, Protocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { InstanceTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { VpcLink } from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import type { SpaApiBackend } from 'cdk-spa-api-gateway';

/**
 * A tiny backend in a VPC, reached through an internal NLB and a VPC link: one EC2 instance
 * answering `GET /objects`, like the public sample backend. It has no internet access (no NAT gateway). Not free.
 */
export class VpcBackend extends Construct implements SpaApiBackend {
  public readonly url: string;

  public readonly vpcLink: VpcLink;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED }],
    });

    const userData = UserData.forLinux();
    userData.addCommands(
      'mkdir -p /srv',
      `echo '[{"id":"3","name":"from the VPC"}]' > /srv/objects`,
      'cd /srv && nohup python3 -m http.server 80 &',
    );
    const instance = new Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
      machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.ARM_64 }),
      userData,
      requireImdsv2: true,
    });

    const nlb = new NetworkLoadBalancer(this, 'Nlb', { vpc, internetFacing: false });
    nlb
      .addListener('Http', { port: 80, protocol: Protocol.TCP })
      .addTargets('Instance', { port: 80, targets: [new InstanceTarget(instance)] });

    this.vpcLink = new VpcLink(this, 'VpcLink', { targets: [nlb] });
    this.url = `http://${nlb.loadBalancerDnsName}`;
  }
}
