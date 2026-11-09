import { Aws, Duration, RemovalPolicy, Tags, Validations } from 'aws-cdk-lib';
import { AuthorizationType, IRequestValidator, LambdaIntegration, RequestAuthorizer, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { CfnPolicy, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DeploymentEnvironment } from '../../shared/environment';
import { runtimeBoundaryArn } from '../cicd-foundation/policy-statements';

export interface ConversationHistoryProps {
  readonly environment: DeploymentEnvironment;
  readonly api: RestApi;
  readonly authorizer: RequestAuthorizer;
  readonly requestValidator: IRequestValidator;
  readonly chatHistoryTable: ITable;
}

/** Owns read-only metadata/HIST/TURN endpoints in Frontend; conversation storage remains owned by AI. */
export class ConversationHistory extends Construct {
  public readonly function: NodejsFunction;
  public readonly role: Role;

  public constructor(scope: Construct, id: string, props: ConversationHistoryProps) {
    super(scope, id);
    const name = `SOC-BOT-${props.environment.toUpperCase()}-FRONTEND-CONVERSATION-HISTORY`;
    const logGroupName = `/aws/lambda/${name}`;
    const logGroup = new LogGroup(this, 'LogGroup', { logGroupName, retention: RetentionDays.ONE_WEEK,
      removalPolicy: props.environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN });
    this.role = new Role(this, 'ExecutionRole', {
      roleName: `SOC_BOT_${props.environment.toUpperCase()}_RUNTIME_APPLICATION_FRONTEND_CONVERSATION_HISTORY`,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(this, 'ApplicationBoundary', runtimeBoundaryArn(props.environment, 'application')),
    });
    Tags.of(this.role).add('SOCBOTAccessClass', 'application');
    this.role.addToPolicy(new PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${logGroupName}:*`] }));
    this.role.addToPolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [`${props.chatHistoryTable.tableArn}/index/GSI1`] }));
    this.role.addToPolicy(new PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem'], resources: [props.chatHistoryTable.tableArn] }));
    const entry = this.handlerEntry();
    this.function = new NodejsFunction(this, 'Function', {
      functionName: name, entry, handler: 'handler', role: this.role, runtime: Runtime.NODEJS_22_X,
      memorySize: 256, timeout: Duration.seconds(60), logGroup,
      depsLockFilePath: resolve(dirname(entry), '../../../../package-lock.json'),
      bundling: { bundleAwsSDK: true, externalModules: [], minify: true, target: 'node22' },
      environment: { DEPLOYMENT_ENVIRONMENT: props.environment, EXPECTED_ACCOUNT_ID: Aws.ACCOUNT_ID,
        FRONTEND_API_ID: props.api.restApiId, CHAT_HISTORY_TABLE_NAME: props.chatHistoryTable.tableName },
    });
    const policy = this.role.node.findChild('DefaultPolicy').node.defaultChild as CfnPolicy;
    policy.policyName = `${name}-POLICY`;
    this.function.node.addDependency(policy, logGroup);
    const apiRoot = props.api.root.getResource('api');
    if (!apiRoot) throw new Error('The frontend API root must exist before history is attached.');
    const conversations = apiRoot.addResource('conversations');
    const method = conversations.addMethod('GET', new LambdaIntegration(this.function, {
      proxy: true, allowTestInvoke: false, scopePermissionToMethod: true, timeout: Duration.seconds(10),
    }), { authorizationType: AuthorizationType.CUSTOM, authorizer: props.authorizer, requestValidator: props.requestValidator });
    const permissions = method.node.findAll().filter((node): node is CfnPermission => node instanceof CfnPermission);
    if (permissions.length !== 1) throw new Error('Expected one invocation permission for conversation listing.');
    permissions[0].sourceAccount = Aws.ACCOUNT_ID;
    permissions[0].sourceArn = props.api.arnForExecuteApi('GET', '/api/conversations', props.environment);
    Validations.of(method.node.defaultChild!).acknowledge({ id: 'AwsSolutions-COG4',
      reason: 'This exact GET uses the existing zero-cache REQUEST authorizer to verify the CloudFront origin and durable opaque session/user state. The handler validates the trusted sub and reconstructs its owner index partition; a JWT authorizer cannot validate the BFF cookie.' });
    // Deployment requires an approved Regional integration allowance of at least 50 seconds.
    const messages = conversations.addResource('{conversationId}').addResource('messages').addMethod('GET', new LambdaIntegration(this.function, {
      proxy: true, allowTestInvoke: false, scopePermissionToMethod: true, timeout: Duration.seconds(50),
    }), { authorizationType: AuthorizationType.CUSTOM, authorizer: props.authorizer, requestValidator: props.requestValidator,
      requestParameters: { 'method.request.path.conversationId': true } });
    const messagePermissions = messages.node.findAll().filter((node): node is CfnPermission => node instanceof CfnPermission);
    if (messagePermissions.length !== 1) throw new Error('Expected one invocation permission for conversation messages.');
    messagePermissions[0].sourceAccount = Aws.ACCOUNT_ID;
    messagePermissions[0].sourceArn = props.api.arnForExecuteApi('GET', '/api/conversations/*/messages', props.environment);
    Validations.of(messages.node.defaultChild!).acknowledge({ id: 'AwsSolutions-COG4',
      reason: 'This messages GET uses the existing zero-cache origin/BFF session authorizer. Both authorizer and handler validate the exact bounded concrete ID; the reader strongly checks conversation ownership before HIST/TURN reads. Only that account/API/stage GET invocation is allowed.' });
    Validations.of(this.function.node.defaultChild!).acknowledge({ id: 'AwsSolutions-L1',
      reason: 'Supported Node.js 22 matches the approved repository and frontend Lambda runtime.' });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:${logGroupName}:*]`,
      reason: 'Only stream creation and event writes within this function\'s managed log group are allowed.' });
  }

  /** Locates the tracked handler from source or compiled infrastructure without shipping test assets. */
  private handlerEntry(): string {
    const candidates = ['../../../lambdas/frontend/conversation-history/handler.ts', '../../../../lambdas/frontend/conversation-history/handler.ts'];
    const entry = candidates.map(path => resolve(__dirname, path)).find(path => existsSync(path));
    if (!entry) throw new Error('Conversation history source was not found.');
    return entry;
  }
}
