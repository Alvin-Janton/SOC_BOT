import { ArnFormat, Aws, CfnOutput, Duration, RemovalPolicy, Stack, Tags, Validations } from 'aws-cdk-lib';
import { CfnWorkGroup } from 'aws-cdk-lib/aws-athena';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { CfnPolicy, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { dataBucketName, DeploymentEnvironment } from '../../shared/environment';
import { DEFAULT_QUERY_WINDOW_DAYS, queryWindowDays } from './query-contract';

export interface AthenaQueryToolProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly dataBucket: IBucket;
  readonly workgroup: CfnWorkGroup;
  readonly database: CfnDatabase;
  readonly tables: readonly CfnTable[];
  readonly maxQueryWindowDays?: number;
}

/** Owns the private, bounded Athena tool and its environment-isolated query execution identity. */
export class AthenaQueryTool extends Construct {
  public readonly function: NodejsFunction;
  public readonly role: Role;

  public constructor(scope: Construct, id: string, props: AthenaQueryToolProps) {
    super(scope, id);
    const { deploymentEnvironment: environment, dataBucket, workgroup, database, tables } = props;
    const upper = environment.toUpperCase();
    const functionName = `SOC-BOT-${upper}-QUERY-TOOL`;
    const logGroupName = `/aws/lambda/${functionName}`;
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    const role = new Role(this, 'ExecutionRole', {
      roleName: `SOC_BOT_${upper}_RUNTIME_QUERY_TOOL`,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(this, 'QueryBoundary',
        `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:policy/SOC_BOT_${upper}_BOUNDARY_QUERY`),
    });
    Tags.of(role).add('SOCBOTAccessClass', 'query');
    this.role = role;

    const logStreamsArn = `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${logGroupName}:*`;
    role.addToPolicy(new PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logStreamsArn] }));
    role.addToPolicy(new PolicyStatement({
      actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution'],
      resources: [Stack.of(this).formatArn({ service: 'athena', resource: 'workgroup', resourceName: workgroup.ref, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
    }));
    const glueArn = (resource: string, resourceName?: string): string => Stack.of(this).formatArn({
      service: 'glue', resource, resourceName, arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    role.addToPolicy(new PolicyStatement({
      actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions'],
      resources: [glueArn('catalog'), glueArn('database', database.ref), ...tables.map((table) => glueArn('table', `${database.ref}/${table.ref}`))],
    }));
    role.addToPolicy(new PolicyStatement({ actions: ['lakeformation:GetDataAccess'], resources: ['*'] }));
    role.addToPolicy(new PolicyStatement({ actions: ['s3:GetBucketLocation'], resources: [dataBucket.bucketArn] }));
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:ListBucket'], resources: [dataBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': ['athena-results', 'athena-results/*'] } },
    }));
    // Reuse the shared physical-name contract for this wildcard ARN and its exact nag acknowledgment.
    const resultsArn = `arn:${Aws.PARTITION}:s3:::${dataBucketName(environment)}/athena-results/*`;
    role.addToPolicy(new PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload'], resources: [resultsArn] }));

    const entry = this.handlerEntry();
    this.function = new NodejsFunction(this, 'Function', {
      functionName, entry, handler: 'handler', role,
      runtime: Runtime.NODEJS_22_X, memorySize: 512, timeout: Duration.seconds(240),
      logGroup,
      depsLockFilePath: resolve(dirname(entry), '../../../../package-lock.json'),
      bundling: { bundleAwsSDK: true, externalModules: [], minify: true, target: 'node22' },
      environment: {
        DATABASE_NAME: database.ref, WORKGROUP_NAME: workgroup.ref,
        RESULTS_BUCKET_NAME: dataBucket.bucketName, RESULTS_PREFIX: 'athena-results/',
        MAX_QUERY_WINDOW_DAYS: String(queryWindowDays(props.maxQueryWindowDays ?? DEFAULT_QUERY_WINDOW_DAYS)),
      },
    });
    const policy = role.node.findChild('DefaultPolicy').node.defaultChild as CfnPolicy;
    policy.policyName = `${functionName}-POLICY`;
    this.function.node.addDependency(policy, logGroup);
    Validations.of(this.function.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'The approved query-tool slice explicitly targets supported Node.js 22, matching CI and the repository engine contract; migration to a newer major runtime is separate work.',
    });
    Validations.of(policy).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'Only lakeformation:GetDataAccess uses *. AWS authorizes this API without resource-level IAM scoping; separate Lake Formation grants restrict this role to the four approved normalized tables.',
    });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:${logGroupName}:*]`,
      reason: 'The query function creates streams only inside its explicitly managed environment log group.',
    });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::soc-bot-${environment}-data-<AWS::AccountId>-<AWS::Region>/athena-results/*]`,
      reason: 'Athena creates execution-specific result objects, limited to athena-results/ in the matching Data-stack bucket.',
    });
    new CfnOutput(this, 'FunctionArn', { value: this.function.functionArn });
    new CfnOutput(this, 'ExecutionRoleArn', { value: role.roleArn });
  }

  /** Finds the tracked TypeScript handler from either source or compiled infrastructure code. */
  private handlerEntry(): string {
    const candidates = ['../../../lambdas/ai/query-tool/handler.ts', '../../../../lambdas/ai/query-tool/handler.ts'].map((path) => resolve(__dirname, path));
    const entry = candidates.find((path) => existsSync(path));
    if (!entry) throw new Error('Athena query-tool source was not found.');
    return entry;
  }
}
