import { Aws, Duration, RemovalPolicy, Tags, Validations } from 'aws-cdk-lib';
import { IdentitySource, RequestAuthorizer, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { CfnPolicy, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DeploymentEnvironment, frontendOriginSecretName } from '../../shared/environment';
import { runtimeBoundaryArn } from '../cicd-foundation/policy-statements';

/** Owns the generated origin token and its exact-secret authorizer, separately from viewer WAF. */
export class FrontendOriginAccess extends Construct {
  public readonly secret: Secret;

  public constructor(scope: Construct, id: string, private readonly environment: DeploymentEnvironment) {
    super(scope, id);
    this.secret = new Secret(this, 'Secret', {
      secretName: frontendOriginSecretName(environment),
      generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
      removalPolicy: environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    Validations.of(this.secret.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-SMG4',
      reason: 'Rotation is explicitly manual and coordinated: Secrets Manager changes alone do not update the CloudFront origin. This token uses the AWS-managed key and no rotation infrastructure; both consumers must be updated deliberately.',
    });
  }

  /** Attaches a zero-cache origin authorizer to the API without introducing API-to-function cycles. */
  public createAuthorizer(api: RestApi): RequestAuthorizer {
    const environment = this.environment;
    const upper = environment.toUpperCase();
    const functionName = `SOC-BOT-${upper}-FRONTEND-ORIGIN-AUTHORIZER`;
    const logGroupName = `/aws/lambda/${functionName}`;
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName, retention: RetentionDays.ONE_WEEK,
      removalPolicy: environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    const role = new Role(this, 'ExecutionRole', {
      roleName: `SOC_BOT_${upper}_RUNTIME_APPLICATION_FRONTEND_ORIGIN_AUTHORIZER`,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(this, 'ApplicationBoundary', runtimeBoundaryArn(environment, 'application')),
    });
    Tags.of(role).add('SOCBOTAccessClass', 'application');
    role.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${logGroupName}:*`],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'], resources: [this.secret.secretArn],
      conditions: { StringEquals: { 'secretsmanager:VersionStage': 'AWSCURRENT' } },
    }));
    const entry = this.handlerEntry();
    const fn = new NodejsFunction(this, 'Function', {
      functionName, entry, handler: 'handler', role, runtime: Runtime.NODEJS_22_X,
      memorySize: 128, timeout: Duration.seconds(10), logGroup,
      depsLockFilePath: resolve(dirname(entry), '../../../../package-lock.json'),
      bundling: { bundleAwsSDK: true, externalModules: [], minify: true, target: 'node22' },
      environment: {
        DEPLOYMENT_ENVIRONMENT: environment, ORIGIN_SECRET_ARN: this.secret.secretArn,
        ALLOWED_METHOD_ARN: api.arnForExecuteApi('GET', '/api/health', environment),
      },
    });
    const policy = role.node.findChild('DefaultPolicy').node.defaultChild as CfnPolicy;
    policy.policyName = `${functionName}-POLICY`;
    fn.node.addDependency(policy, logGroup);
    const authorizer = new RequestAuthorizer(this, 'Authorizer', {
      authorizerName: functionName, handler: fn, resultsCacheTtl: Duration.seconds(0),
      identitySources: [IdentitySource.header('X-Soc-Bot-Origin')],
    });
    // CDK scopes its generated permission to this API/authorizer; add the matching source account.
    const permissions = fn.node.findAll().filter((node): node is CfnPermission => node instanceof CfnPermission);
    if (permissions.length !== 1) throw new Error('Expected one API authorizer invocation permission.');
    permissions[0].sourceAccount = Aws.ACCOUNT_ID;
    Validations.of(fn.node.defaultChild!).acknowledge({ id: 'AwsSolutions-L1',
      reason: 'The approved frontend origin authorizer uses supported Node.js 22, matching the repository and existing runtime convention.' });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:${logGroupName}:*]`,
      reason: 'Only stream creation and event writes inside this authorizer\'s explicitly managed log group are allowed.',
    });
    return authorizer;
  }

  /** Locates the tracked handler from either source or compiled infrastructure. */
  private handlerEntry(): string {
    const candidates = ['../../../lambdas/frontend/origin-authorizer/handler.ts', '../../../../lambdas/frontend/origin-authorizer/handler.ts'];
    const entry = candidates.map(path => resolve(__dirname, path)).find(path => existsSync(path));
    if (!entry) throw new Error('Frontend origin-authorizer source was not found.');
    return entry;
  }
}
