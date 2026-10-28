import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DeploymentEnvironment } from '../../shared/environment';
import { AuthStorage } from './auth-storage';
import { FrontendApi } from './frontend-api';
import { FrontendHosting } from './frontend-hosting';
import { FrontendIdentity } from './frontend-identity';
import { FrontendOriginAccess } from './frontend-origin-access';
import { devFrontendClientCidr, FrontendWaf } from './frontend-waf';

export interface FrontendStackProps extends StackProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly devFrontendAllowedClientCidr?: string;
}

/** Owns independent frontend/auth resources; no AI reference, auth handler, assets or user is provisioned. */
export class FrontendStack extends Stack {
  public readonly authStorage: AuthStorage;
  public readonly identity: FrontendIdentity;
  public readonly api: FrontendApi;
  public readonly hosting: FrontendHosting;

  public constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);
    const environment = props.deploymentEnvironment;
    this.authStorage = new AuthStorage(this, 'AuthStorage', environment);
    this.identity = new FrontendIdentity(this, 'Identity', environment);
    const originAccess = new FrontendOriginAccess(this, 'OriginAccess', environment);
    const waf = environment === 'dev'
      ? new FrontendWaf(this, 'FrontendWaf', devFrontendClientCidr(props.devFrontendAllowedClientCidr)) : undefined;
    this.api = new FrontendApi(this, 'FrontendApi', environment, originAccess);
    this.hosting = new FrontendHosting(this, 'Hosting', {
      environment, api: this.api.api, originAccess, webAclArn: waf?.webAcl.attrArn,
    });
    Tags.of(this).add('Project', 'SOC_BOT');
    Tags.of(this).add('Environment', environment);
    Tags.of(this).add('ManagedBy', 'CDK');
    new CfnOutput(this, 'CloudFrontHostname', { value: this.hosting.distribution.distributionDomainName });
    new CfnOutput(this, 'DistributionId', { value: this.hosting.distribution.distributionId });
    new CfnOutput(this, 'FrontendBucketName', { value: this.hosting.bucket.bucketName });
    new CfnOutput(this, 'FrontendApiId', { value: this.api.api.restApiId });
    new CfnOutput(this, 'HealthUrl', { value: `https://${this.hosting.distribution.distributionDomainName}/api/health` });
    new CfnOutput(this, 'UserPoolId', { value: this.identity.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.identity.client.userPoolClientId });
    new CfnOutput(this, 'AuthSessionsTableName', { value: this.authStorage.table.tableName });
  }
}
