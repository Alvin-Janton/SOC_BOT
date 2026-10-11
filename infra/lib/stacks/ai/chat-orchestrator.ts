import { Aws, CfnOutput, Duration, RemovalPolicy, Tags, Validations } from 'aws-cdk-lib';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { CfnPolicy, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { IFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DeploymentEnvironment } from '../../shared/environment';
import { BEDROCK_INFERENCE_PROFILE, runtimeBoundaryArn } from '../cicd-foundation/policy-statements';
import { DEFAULT_QUERY_WINDOW_DAYS, queryWindowDays } from './query-contract';

export interface ChatOrchestratorProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly chatHistoryTable: ITable;
  readonly queryToolFunction: IFunction;
  readonly databaseName: string;
  readonly maxQueryWindowDays?: number;
}

/** Owns the dev-only private streaming orchestrator and its application execution identity. */
export class ChatOrchestrator extends Construct {
  public readonly function: NodejsFunction;
  public readonly role: Role;

  public constructor(scope: Construct, id: string, props: ChatOrchestratorProps) {
    super(scope, id);
    if (props.deploymentEnvironment !== 'dev') {
      throw new Error('The chat orchestrator is available only in dev until authentication is integrated.');
    }
    const functionName = 'SOC-BOT-DEV-CHAT-ORCHESTRATOR';
    const logGroupName = `/aws/lambda/${functionName}`;
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new Role(this, 'ExecutionRole', {
      roleName: 'SOC_BOT_DEV_RUNTIME_APPLICATION_CHAT_ORCHESTRATOR',
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(this, 'ApplicationBoundary',
        runtimeBoundaryArn('dev', 'application')),
    });
    Tags.of(role).add('SOCBOTAccessClass', 'application');
    this.role = role;

    const logStreamsArn = `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${logGroupName}:*`;
    role.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [logStreamsArn],
    }));
    // Transactional conditional Update/Put operations use these underlying item permissions.
    role.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
      resources: [props.chatHistoryTable.tableArn],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [props.queryToolFunction.functionArn],
    }));
    const inferenceProfileArn = `arn:${Aws.PARTITION}:bedrock:${BEDROCK_INFERENCE_PROFILE.sourceRegion}:${Aws.ACCOUNT_ID}:inference-profile/${BEDROCK_INFERENCE_PROFILE.profileId}`;
    const foundationModelArn = `arn:${Aws.PARTITION}:bedrock:*::foundation-model/${BEDROCK_INFERENCE_PROFILE.foundationModelId}`;
    role.addToPolicy(new PolicyStatement({
      actions: ['bedrock:InvokeModelWithResponseStream'],
      resources: [inferenceProfileArn],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['bedrock:GetInferenceProfile'],
      resources: [inferenceProfileArn],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['bedrock:InvokeModelWithResponseStream'],
      resources: [foundationModelArn],
      conditions: { StringEquals: { 'bedrock:InferenceProfileArn': inferenceProfileArn } },
    }));

    const entry = this.handlerEntry();
    this.function = new NodejsFunction(this, 'Function', {
      functionName, entry, handler: 'handler', role,
      runtime: Runtime.NODEJS_22_X, memorySize: 512, timeout: Duration.minutes(15),
      logGroup,
      depsLockFilePath: resolve(dirname(entry), '../../../../package-lock.json'),
      bundling: { bundleAwsSDK: true, externalModules: [], minify: true, target: 'node22' },
      environment: {
        DEPLOYMENT_ENVIRONMENT: 'dev',
        DEV_USER_ID: 'soc-bot-dev-analyst',
        CHAT_HISTORY_TABLE_NAME: props.chatHistoryTable.tableName,
        QUERY_TOOL_FUNCTION_NAME: props.queryToolFunction.functionName,
        BEDROCK_MODEL_ID: BEDROCK_INFERENCE_PROFILE.profileId,
        BEDROCK_REGION: BEDROCK_INFERENCE_PROFILE.sourceRegion,
        DATABASE_NAME: props.databaseName,
        MAX_QUERY_WINDOW_DAYS: String(queryWindowDays(props.maxQueryWindowDays ?? DEFAULT_QUERY_WINDOW_DAYS)),
      },
    });
    const policy = role.node.findChild('DefaultPolicy').node.defaultChild as CfnPolicy;
    policy.policyName = `${functionName}-POLICY`;
    this.function.node.addDependency(policy, logGroup);
    Validations.of(this.function.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'The approved dev orchestrator targets supported Node.js 22, matching CI and the repository engine contract; migration to a newer major runtime is separate work.',
    });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:${logGroupName}:*]`,
      reason: 'The orchestrator creates log streams only inside its explicitly managed dev log group.',
    });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:bedrock:*::foundation-model/${BEDROCK_INFERENCE_PROFILE.foundationModelId}]`,
      reason: 'The Region wildcard supports US routing destinations for the approved model; the exact us-east-1 inference-profile condition prevents direct model invocation or another profile.',
    });
    Tags.of(this).add('Project', 'SOC_BOT');
    Tags.of(this).add('Environment', 'dev');
    Tags.of(this).add('ManagedBy', 'CDK');
    new CfnOutput(this, 'FunctionArn', { value: this.function.functionArn });
    new CfnOutput(this, 'ExecutionRoleArn', { value: role.roleArn });
  }

  /** Finds the tracked TypeScript handler from source or compiled infrastructure code. */
  private handlerEntry(): string {
    const candidates = ['../../../lambdas/ai/chat-orchestrator/handler.ts', '../../../../lambdas/ai/chat-orchestrator/handler.ts']
      .map((path) => resolve(__dirname, path));
    const entry = candidates.find((path) => existsSync(path));
    if (!entry) throw new Error('Chat orchestrator source was not found.');
    return entry;
  }
}
