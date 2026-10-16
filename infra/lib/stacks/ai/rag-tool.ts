import { Aws, CfnOutput, Duration, RemovalPolicy, Tags, Validations } from 'aws-cdk-lib';
import { CfnPolicy, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DeploymentEnvironment } from '../../shared/environment';
import { runtimeBoundaryArn } from '../cicd-foundation/policy-statements';

export interface RagToolProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly dataBucket: IBucket;
}

/** Owns only the private, read-only document tool, with no orchestrator invocation grant or API. */
export class RagTool extends Construct {
  public readonly function: NodejsFunction;
  public readonly role: Role;

  public constructor(scope: Construct, id: string, props: RagToolProps) {
    super(scope, id);
    const environment = props.deploymentEnvironment;
    const upper = environment.toUpperCase();
    const functionName = `SOC-BOT-${upper}-RAG-TOOL`;
    const logGroupName = `/aws/lambda/${functionName}`;
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName, retention: RetentionDays.ONE_WEEK,
      removalPolicy: environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    this.role = new Role(this, 'ExecutionRole', {
      roleName: `SOC_BOT_${upper}_RUNTIME_APPLICATION_RAG_TOOL`,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(this, 'ApplicationBoundary', runtimeBoundaryArn(environment, 'application')),
    });
    Tags.of(this.role).add('SOCBOTAccessClass', 'application');
    this.role.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${logGroupName}:*`],
    }));
    this.role.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject'], resources: [props.dataBucket.arnForObjects('playbooks/*')],
    }));
    const entry = this.handlerEntry();
    this.function = new NodejsFunction(this, 'Function', {
      functionName, entry, handler: 'handler', role: this.role,
      runtime: Runtime.NODEJS_22_X, memorySize: 512, timeout: Duration.minutes(3), logGroup,
      depsLockFilePath: resolve(dirname(entry), '../../../../package-lock.json'),
      bundling: { bundleAwsSDK: true, externalModules: [], minify: true, target: 'node22' },
      environment: {
        DEPLOYMENT_ENVIRONMENT: environment, PLAYBOOKS_BUCKET_NAME: props.dataBucket.bucketName,
        PLAYBOOK_INDEX_KEY: 'playbooks/index.json',
      },
    });
    const policy = this.role.node.findChild('DefaultPolicy').node.defaultChild as CfnPolicy;
    policy.policyName = `${functionName}-POLICY`;
    this.function.node.addDependency(policy, logGroup);
    Validations.of(this.function.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'The approved standalone RAG tool targets supported Node.js 22, matching the repository engine and existing tools; a newer major runtime is separate work.',
    });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:${logGroupName}:*]`,
      reason: 'The RAG function creates streams only in its own explicitly managed environment log group.',
    });
    // cdk-nag v3 identifies this imported ARN by the existing Data bucket's export name.
    // A changed bucket export must be reviewed and re-acknowledged; IAM keeps the actual bucket reference.
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::SOC-BOT-${upper}-DATA:ExportsOutputFnGetAttDataBucketE3889A50Arn98F8399F/playbooks/*]`,
      reason: 'GetObject requires an object wildcard for the fixed index and indexed Markdown documents; access stays inside playbooks/ of the matching Data-stack bucket, with no listing or writes.',
    });
    Tags.of(this).add('Project', 'SOC_BOT');
    Tags.of(this).add('Environment', environment);
    Tags.of(this).add('ManagedBy', 'CDK');
    new CfnOutput(this, 'FunctionArn', { value: this.function.functionArn });
    new CfnOutput(this, 'ExecutionRoleArn', { value: this.role.roleArn });
  }

  /** Locates the tracked entry from either TypeScript source or the compiled infrastructure directory. */
  private handlerEntry(): string {
    const candidates = ['../../../lambdas/ai/rag-tool/handler.ts', '../../../../lambdas/ai/rag-tool/handler.ts']
      .map(path => resolve(__dirname, path));
    const entry = candidates.find(path => existsSync(path));
    if (!entry) throw new Error('RAG-tool source was not found.');
    return entry;
  }
}
