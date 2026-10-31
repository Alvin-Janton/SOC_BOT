import { Aws, CfnOutput, Duration, RemovalPolicy, SecretValue, Tags, Validations } from 'aws-cdk-lib';
import { CfnUserPoolDomain, CfnUserPoolIdentityProvider, OAuthScope, UserPool, UserPoolClient, UserPoolClientIdentityProvider, UserPoolOperation } from 'aws-cdk-lib/aws-cognito';
import { CfnPolicy, ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runtimeBoundaryArn } from '../cicd-foundation/policy-statements';

export interface FrontendGoogleLoginProps {
  readonly userPool: UserPool;
  readonly browserOrigin: string;
  readonly enabled: boolean;
}

/** Stages dev credentials/domain independently; activation adds Google, its client and creation guard. */
export class FrontendGoogleLogin extends Construct {
  public readonly client?: UserPoolClient;
  public readonly domain: string;
  public readonly redirectUri: string;
  public readonly credentialSecretArn: string;
  public readonly linkRedirectUri: string;

  public constructor(scope: Construct, id: string, props: FrontendGoogleLoginProps) {
    super(scope, id);
    // Neither SecretString nor GenerateSecretString: CloudFormation creates an empty credential container.
    const secret = new CfnSecret(this, 'Credentials', { name: 'SOC-BOT-DEV-GOOGLE-OAUTH',
      description: props.enabled ? 'Operator-provisioned Google OAuth credentials; exact dev auth reads AWSCURRENT only for explicit linking.'
        : 'Operator-provisioned Google OAuth clientId/clientSecret; never read by runtime roles.' });
    this.credentialSecretArn = secret.ref;
    secret.applyRemovalPolicy(RemovalPolicy.DESTROY);
    Validations.of(secret).acknowledge({ id: 'AwsSolutions-SMG4',
      reason: 'Google credentials are populated and rotated by the operator. Rotation must explicitly refresh the Cognito provider configuration; a secret-value update alone does not reapply dynamic references.' });
    const domain = new CfnUserPoolDomain(this, 'Domain', { userPoolId: props.userPool.userPoolId,
      domain: `soc-bot-dev-${Aws.ACCOUNT_ID}-${Aws.REGION}` });
    this.domain = `https://${domain.ref}.auth.${Aws.REGION}.amazoncognito.com`;
    this.redirectUri = `${props.browserOrigin}/api/auth/google/callback`;
    this.linkRedirectUri = `${props.browserOrigin}/api/auth/link/google/callback`;
    new CfnOutput(this, 'CognitoDomain', { value: this.domain });
    new CfnOutput(this, 'GoogleRedirectUri', { value: `${this.domain}/oauth2/idpresponse` });
    new CfnOutput(this, 'CredentialSecretArn', { value: secret.ref });
    if (!props.enabled) return;
    new CfnOutput(this, 'GoogleLinkCallbackUri', { value: this.linkRedirectUri });

    const provider = new CfnUserPoolIdentityProvider(this, 'Provider', {
      userPoolId: props.userPool.userPoolId, providerName: 'Google', providerType: 'Google',
      providerDetails: {
        client_id: SecretValue.secretsManager(secret.ref, { jsonField: 'clientId' }).unsafeUnwrap(),
        client_secret: SecretValue.secretsManager(secret.ref, { jsonField: 'clientSecret' }).unsafeUnwrap(),
        authorize_scopes: 'openid email profile',
      }, attributeMapping: { email: 'email', email_verified: 'email_verified' },
    });
    this.client = new UserPoolClient(this, 'Client', {
      userPool: props.userPool, userPoolClientName: 'SOC-BOT-DEV-GOOGLE-CLIENT', generateSecret: false,
      preventUserExistenceErrors: true, enableTokenRevocation: true,
      authFlows: { userPassword: false, userSrp: false, custom: false, adminUserPassword: false },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.GOOGLE],
      oAuth: { flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE], callbackUrls: [this.redirectUri] },
    });
    this.client.node.addDependency(provider, domain);
    this.addCollisionGuard(props.userPool);
  }

  /** Attaches an exact-pool trigger without putting a pool reference in its function configuration. */
  private addCollisionGuard(pool: UserPool): void {
    const name = 'SOC-BOT-DEV-GOOGLE-PRE-SIGNUP';
    const logGroupName = `/aws/lambda/${name}`;
    const logs = new LogGroup(this, 'GuardLogs', { logGroupName, retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
    const role = new Role(this, 'GuardRole', {
      roleName: 'SOC_BOT_DEV_RUNTIME_APPLICATION_GOOGLE_PRE_SIGNUP', assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(this, 'ApplicationBoundary', runtimeBoundaryArn('dev', 'application')),
    });
    Tags.of(role).add('SOCBOTAccessClass', 'application');
    const entry = ['../../../lambdas/frontend/auth/google-pre-signup.ts', '../../../../lambdas/frontend/auth/google-pre-signup.ts']
      .map(path => resolve(__dirname, path)).find(path => existsSync(path));
    if (!entry) throw new Error('Google pre-signup source was not found.');
    const fn = new NodejsFunction(this, 'Guard', { functionName: name, entry, handler: 'handler', role,
      runtime: Runtime.NODEJS_22_X, memorySize: 128, timeout: Duration.seconds(4), logGroup: logs,
      depsLockFilePath: resolve(dirname(entry), '../../../../package-lock.json'),
      bundling: { bundleAwsSDK: true, externalModules: [], minify: true, target: 'node22' },
      environment: { EXPECTED_ACCOUNT_ID: Aws.ACCOUNT_ID },
    });
    // A standalone attachment avoids Lambda's automatic dependency on a Role default policy.
    // The policy needs the pool ARN, while the pool itself references this function as a trigger.
    const policy = new CfnPolicy(this, 'GuardPolicy', { policyName: `${name}-POLICY`, roles: [role.roleName],
      policyDocument: new PolicyDocument({ statements: [
        new PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${logGroupName}:*`] }),
        new PolicyStatement({ actions: ['cognito-idp:AdminGetUser'], resources: [pool.userPoolArn] }),
      ] }).toJSON(),
    });
    // No function -> policy edge: the attachment completes before the stack is ready for sign-in.
    pool.addTrigger(UserPoolOperation.PRE_SIGN_UP, fn);
    // UserPool.addTrigger owns its generated Lambda permission under the pool, not the function.
    const permission = pool.node.findChild('PreSignUpCognito');
    if (!(permission instanceof CfnPermission)) throw new Error('Expected the Cognito guard invocation permission.');
    permission.sourceAccount = Aws.ACCOUNT_ID;
    permission.sourceArn = pool.userPoolArn;
    Validations.of(fn.node.defaultChild!).acknowledge({ id: 'AwsSolutions-L1',
      reason: 'The bounded Cognito trigger uses supported Node.js 22, matching the approved frontend runtime.' });
    Validations.of(policy).acknowledge({ id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:${logGroupName}:*]`,
      reason: 'Only stream creation/event writes in this guard\'s explicitly managed log group are allowed.' });
  }
}
