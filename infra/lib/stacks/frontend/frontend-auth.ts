import { Aws, Duration, RemovalPolicy, Tags, Validations } from 'aws-cdk-lib';
import { AuthorizationType, IRequestValidator, LambdaIntegration, RequestAuthorizer, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { CfnPolicy, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { frontendOriginRoutes } from '../../../lambdas/frontend/shared/origin-routes';
import { DeploymentEnvironment } from '../../shared/environment';
import { runtimeBoundaryArn } from '../cicd-foundation/policy-statements';

export interface FrontendAuthProps {
  readonly environment: DeploymentEnvironment;
  readonly api: RestApi;
  readonly authorizer: RequestAuthorizer;
  readonly requestValidator: IRequestValidator;
  readonly userPool: IUserPool;
  readonly client: IUserPoolClient;
  readonly table: ITable;
  readonly browserOrigin: string;
  readonly google?: { readonly client: IUserPoolClient; readonly domain: string; readonly redirectUri: string };
}

/** Owns explicit authentication routes and one exact-pool/table Lambda, without chat integration. */
export class FrontendAuth extends Construct {
  public readonly function: NodejsFunction;
  public readonly role: Role;

  public constructor(scope: Construct, id: string, props: FrontendAuthProps) {
    super(scope, id);
    const name = `SOC-BOT-${props.environment.toUpperCase()}-FRONTEND-AUTH`;
    const logGroupName = `/aws/lambda/${name}`;
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName, retention: RetentionDays.ONE_WEEK,
      removalPolicy: props.environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    this.role = new Role(this, 'ExecutionRole', {
      roleName: `SOC_BOT_${props.environment.toUpperCase()}_RUNTIME_APPLICATION_FRONTEND_AUTH`,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(this, 'ApplicationBoundary', runtimeBoundaryArn(props.environment, 'application')),
    });
    Tags.of(this.role).add('SOCBOTAccessClass', 'application');
    this.role.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${logGroupName}:*`],
    }));
    this.role.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:ConditionCheckItem', 'dynamodb:UpdateItem'],
      resources: [props.table.tableArn],
    }));
    this.role.addToPolicy(new PolicyStatement({ actions: ['cognito-idp:AdminGetUser'], resources: [props.userPool.userPoolArn] }));
    const entry = this.handlerEntry();
    this.function = new NodejsFunction(this, 'Function', {
      functionName: name, entry, handler: 'handler', role: this.role,
      runtime: Runtime.NODEJS_22_X, memorySize: 256, timeout: Duration.seconds(25), logGroup,
      depsLockFilePath: resolve(dirname(entry), '../../../../package-lock.json'),
      bundling: { bundleAwsSDK: true, externalModules: [], minify: true, target: 'node22' },
      environment: {
        DEPLOYMENT_ENVIRONMENT: props.environment, USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.client.userPoolClientId, AUTH_SESSION_TABLE_NAME: props.table.tableName,
        EXPECTED_ACCOUNT_ID: Aws.ACCOUNT_ID, FRONTEND_API_ID: props.api.restApiId, BROWSER_ORIGIN: props.browserOrigin,
        ...(props.google ? { GOOGLE_LOGIN_ENABLED: 'true', GOOGLE_USER_POOL_CLIENT_ID: props.google.client.userPoolClientId,
          GOOGLE_COGNITO_DOMAIN: props.google.domain, GOOGLE_CALLBACK_URI: props.google.redirectUri } : {}),
      },
    });
    const policy = this.role.node.findChild('DefaultPolicy').node.defaultChild as CfnPolicy;
    policy.policyName = `${name}-POLICY`;
    this.function.node.addDependency(policy, logGroup);
    const apiRoot = props.api.root.getResource('api');
    if (!apiRoot) throw new Error('The frontend API root must exist before auth routes are attached.');
    const authRoot = apiRoot.addResource('auth');
    const googleRoot = props.google ? authRoot.addResource('google') : undefined;
    for (const route of frontendOriginRoutes(props.google !== undefined).filter(candidate => candidate.route !== 'health')) {
      const resource = route.route === 'google-start' ? googleRoot!.addResource('start')
        : route.route === 'google-callback' ? googleRoot!.addResource('callback') : authRoot.addResource(route.route);
      const method = resource.addMethod(route.method, new LambdaIntegration(this.function, {
        proxy: true, allowTestInvoke: false, scopePermissionToMethod: true, timeout: Duration.seconds(25),
      }), {
        authorizationType: AuthorizationType.CUSTOM, authorizer: props.authorizer,
        requestValidator: props.requestValidator,
      });
      const permissions = method.node.findAll().filter((node): node is CfnPermission => node instanceof CfnPermission);
      if (permissions.length !== 1) throw new Error('Expected one invocation permission per auth method.');
      permissions[0].sourceAccount = Aws.ACCOUNT_ID;
      permissions[0].sourceArn = props.api.arnForExecuteApi(route.method, route.resource, props.environment);
      const registration = ['signup', 'confirm-signup', 'resend-confirmation'].includes(route.route);
      const recovery = ['forgot-password', 'reset-password'].includes(route.route);
      Validations.of(method.node.defaultChild!).acknowledge({ id: 'AwsSolutions-COG4',
        reason: registration
          ? 'This registration method requires CloudFront origin verification and browser Origin validation, without a prior session. Cognito owns account/code verification; explicit login is separate. Public-demo signup/email abuse controls remain deferred.'
          : route.route === 'google-start' || route.route === 'google-callback'
            ? 'Dev-only Google navigation requires origin verification; callback additionally requires browser-bound one-time state, PKCE, nonce, verified Cognito identity and conditional opaque-session persistence. No prior JWT exists; public-demo Google activation remains deferred.'
            : recovery
              ? 'This recovery method requires origin verification and browser Origin validation without a prior session. Reset additionally requires Cognito recovery-code proof; only confirmed password success permits application-session revocation. Public-demo abuse controls remain deferred.'
              : route.route === 'change-password'
                ? 'This method requires origin verification, browser Origin validation, a valid revalidated opaque session and fresh current-password/access-token proof. A native Cognito JWT authorizer cannot validate the BFF cookie; public-demo abuse controls remain deferred.'
                : 'This exact route uses origin verification plus BFF password/session validation instead of a native Cognito JWT authorizer. Opaque cookies are resolved by the auth Lambda; login requires no prior session. Public-demo abuse controls remain deferred.',
      });
    }
    Validations.of(this.function.node.defaultChild!).acknowledge({ id: 'AwsSolutions-L1',
      reason: 'The approved auth runtime is supported Node.js 22, matching the repository and existing frontend authorizer.' });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:${logGroupName}:*]`,
      reason: 'Only stream creation and event writes in this function\'s explicitly managed log group are allowed.',
    });
  }

  /** Finds the tracked auth entry point from TypeScript source or compiled infrastructure. */
  private handlerEntry(): string {
    const candidates = ['../../../lambdas/frontend/auth/handler.ts', '../../../../lambdas/frontend/auth/handler.ts'];
    const entry = candidates.map(path => resolve(__dirname, path)).find(path => existsSync(path));
    if (!entry) throw new Error('Frontend auth source was not found.');
    return entry;
  }
}
