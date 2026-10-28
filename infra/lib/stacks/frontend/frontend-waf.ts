import { CfnIPSet, CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { isIP } from 'node:net';

/** Requires an independent single IPv4 client without exposing the supplied address in errors. */
export function devFrontendClientCidr(value: unknown): string {
  if (typeof value !== 'string' || !value.endsWith('/32') || isIP(value.slice(0, -3)) !== 4) {
    throw new Error('Set CDK context devFrontendAllowedClientCidr to a valid IPv4 /32 CIDR.');
  }
  return value;
}

/** Owns only the dev CloudFront IPv4 gate; the existing Regional chat WAF is independent. */
export class FrontendWaf extends Construct {
  public readonly webAcl: CfnWebACL;

  public constructor(scope: Construct, id: string, clientCidr: string) {
    super(scope, id);
    const ipSet = new CfnIPSet(this, 'ClientIpSet', {
      name: 'SOC-BOT-DEV-FRONTEND-CLIENTS', scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV4', addresses: [devFrontendClientCidr(clientCidr)],
    });
    const visibilityConfig = {
      cloudWatchMetricsEnabled: true, sampledRequestsEnabled: false, metricName: 'SOC-BOT-DEV-FRONTEND-ALLOWLIST',
    };
    this.webAcl = new CfnWebACL(this, 'WebAcl', {
      name: 'SOC-BOT-DEV-FRONTEND-ALLOWLIST', scope: 'CLOUDFRONT', defaultAction: { block: {} }, visibilityConfig,
      rules: [{ name: 'AllowConfiguredClient', priority: 0, action: { allow: {} },
        statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } },
        visibilityConfig: { ...visibilityConfig, metricName: 'SOC-BOT-DEV-FRONTEND-CLIENT' },
      }],
    });
  }
}
