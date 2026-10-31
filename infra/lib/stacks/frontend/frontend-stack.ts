import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DeploymentEnvironment } from '../../shared/environment';
import { AuthStorage } from './auth-storage';
import { FrontendApi } from './frontend-api';
import { FrontendHosting } from './frontend-hosting';
import { FrontendIdentity } from './frontend-identity';
import { FrontendOriginAccess } from './frontend-origin-access';
import { devFrontendClientCidr, FrontendWaf } from './frontend-waf';
import { FrontendAuth } from './frontend-auth';
import { FrontendGoogleLogin } from './frontend-google-login';

export interface FrontendStackProps extends StackProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly devFrontendAllowedClientCidr?: string;
  readonly devGoogleLoginEnabled?: boolean;
}

/** Owns frontend hosting and session routes without creating users, assets or an AI identity integration. */
export class FrontendStack extends Stack {
  public readonly authStorage: AuthStorage;
  public readonly identity: FrontendIdentity;
  public readonly api: FrontendApi;
  public readonly hosting: FrontendHosting;
  public readonly auth: FrontendAuth;

  public constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);
    const environment = props.deploymentEnvironment;
    if (props.devGoogleLoginEnabled !== undefined && typeof props.devGoogleLoginEnabled !== 'boolean') throw new Error('Google activation must be boolean.');
    if (environment !== 'dev' && props.devGoogleLoginEnabled) throw new Error('Google login is dev-only.');
    this.authStorage = new AuthStorage(this, 'AuthStorage', environment);
    this.identity = new FrontendIdentity(this, 'Identity', environment);
    const originAccess = new FrontendOriginAccess(this, 'OriginAccess', environment, props.devGoogleLoginEnabled ?? false);
    const waf = environment === 'dev'
      ? new FrontendWaf(this, 'FrontendWaf', devFrontendClientCidr(props.devFrontendAllowedClientCidr)) : undefined;
    this.api = new FrontendApi(this, 'FrontendApi', environment, originAccess);
    this.hosting = new FrontendHosting(this, 'Hosting', {
      environment, api: this.api.api, originAccess, webAclArn: waf?.webAcl.attrArn,
    });
    // Hosting references only the API ID, so the integration can safely reference its generated hostname.
    const google = environment === 'dev' ? new FrontendGoogleLogin(this, 'GoogleLogin', {
      userPool: this.identity.userPool, browserOrigin: `https://${this.hosting.distribution.distributionDomainName}`,
      enabled: props.devGoogleLoginEnabled ?? false,
    }) : undefined;
    this.auth = new FrontendAuth(this, 'Auth', {
      environment, api: this.api.api, authorizer: this.api.originAuthorizer,
      requestValidator: this.api.requestValidator,
      userPool: this.identity.userPool, client: this.identity.client, table: this.authStorage.table,
      browserOrigin: `https://${this.hosting.distribution.distributionDomainName}`,
      google: google?.client ? { client: google.client, domain: google.domain, redirectUri: google.redirectUri,
        credentialSecretArn: google.credentialSecretArn, linkRedirectUri: google.linkRedirectUri } : undefined,
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
