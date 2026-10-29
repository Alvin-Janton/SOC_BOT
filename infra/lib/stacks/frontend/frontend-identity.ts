import { RemovalPolicy, Validations } from 'aws-cdk-lib';
import { AccountRecovery, Mfa, UserPool, UserPoolClient, UserPoolClientIdentityProvider,
  UserPoolEmail, VerificationEmailStyle } from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { DeploymentEnvironment } from '../../shared/environment';

/** Provisions the email/password pool/client; the auth construct owns their HTTP session routes. */
export class FrontendIdentity extends Construct {
  public readonly userPool: UserPool;
  public readonly client: UserPoolClient;

  public constructor(scope: Construct, id: string, environment: DeploymentEnvironment) {
    super(scope, id);
    const prefix = `SOC-BOT-${environment.toUpperCase()}`;
    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `${prefix}-USERS`, selfSignUpEnabled: true,
      signInAliases: { email: true }, signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: true } },
      autoVerify: { email: true }, userVerification: { emailStyle: VerificationEmailStyle.CODE },
      email: UserPoolEmail.withCognito(), accountRecovery: AccountRecovery.EMAIL_ONLY, mfa: Mfa.OFF,
      passwordPolicy: { minLength: 15, requireDigits: false, requireLowercase: false,
        requireUppercase: false, requireSymbols: false },
      removalPolicy: environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    this.client = this.userPool.addClient('Client', {
      userPoolClientName: `${prefix}-WEB`, generateSecret: false,
      authFlows: { userPassword: true }, preventUserExistenceErrors: true, disableOAuth: true,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
    });
    this.client.applyRemovalPolicy(environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN);
    for (const [rule, reason] of [
      ['COG1', 'The approved password policy requires at least 15 characters without arbitrary composition requirements; confirmation and email verification remain enabled.'],
      ['COG2', 'MFA is explicitly deferred for the approved password/session routes; challenges fail closed. Public-demo rollout and comprehensive authentication abuse controls remain separate reviewed work.'],
      ['COG8', 'The paid Plus tier and its advanced threat protection are outside this bounded MVP foundation. Their cost/security configuration and abuse controls require review before public demo release.'],
    ]) Validations.of(this.userPool.node.defaultChild!).acknowledge({ id: `AwsSolutions-${rule}`, reason });
  }
}
