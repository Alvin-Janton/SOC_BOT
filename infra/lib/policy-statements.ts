import { Aws } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';

export type DeploymentEnvironment = 'dev' | 'demo';

export interface EnvironmentResources {
  readonly environment: DeploymentEnvironment;
  readonly prefix: string;
  readonly databasePrefix: string;
  readonly dataBucketName: string;
  readonly frontendBucketName: string;
  readonly executionRoleArn: string;
  readonly boundaryArn: string;
}

/** Builds deterministic, environment-qualified names and ARNs used by IAM policies. */
export function environmentResources(environment: DeploymentEnvironment): EnvironmentResources {
  const upper = environment.toUpperCase();
  return {
    environment,
    prefix: `SOC-BOT-${upper}`,
    databasePrefix: `soc_bot_${environment}`,
    dataBucketName: `soc-bot-${environment}-data-${Aws.ACCOUNT_ID}-${Aws.REGION}`,
    frontendBucketName: `soc-bot-${environment}-frontend-${Aws.ACCOUNT_ID}-${Aws.REGION}`,
    executionRoleArn: `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/SOC_BOT_${upper}_CFN_EXEC`,
    boundaryArn: `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:policy/SOC_BOT_${upper}_RUNTIME_BOUNDARY`,
  };
}

/** Defines the permissions used by GitHub Actions to deploy one application environment. */
export function deploymentStatements(resources: EnvironmentResources): PolicyStatement[] {
  const cloudFormationActions = [
    'cloudformation:CancelUpdateStack',
    'cloudformation:ContinueUpdateRollback',
    'cloudformation:CreateChangeSet',
    'cloudformation:CreateStack',
    'cloudformation:DeleteChangeSet',
    'cloudformation:DescribeChangeSet',
    'cloudformation:DescribeStackEvents',
    'cloudformation:DescribeStackResources',
    'cloudformation:DescribeStacks',
    'cloudformation:ExecuteChangeSet',
    'cloudformation:GetTemplate',
    'cloudformation:GetTemplateSummary',
    'cloudformation:ListChangeSets',
    'cloudformation:ListStackResources',
    'cloudformation:RollbackStack',
    'cloudformation:UpdateStack',
  ];
  if (resources.environment === 'dev') {
    cloudFormationActions.push('cloudformation:DeleteStack');
  }

  const assetBucketArn = `arn:${Aws.PARTITION}:s3:::cdk-hnb659fds-assets-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
  const frontendBucketArn = `arn:${Aws.PARTITION}:s3:::${resources.frontendBucketName}`;

  return [
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}ProjectStacks`,
      actions: cloudFormationActions,
      resources: [
        `arn:${Aws.PARTITION}:cloudformation:${Aws.REGION}:${Aws.ACCOUNT_ID}:stack/${resources.prefix}-*/*`,
      ],
    }),
    new PolicyStatement({
      sid: `PassOnly${capitalize(resources.environment)}CloudFormationExecutionRole`,
      actions: ['iam:PassRole'],
      resources: [resources.executionRoleArn],
      conditions: {
        StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' },
      },
    }),
    new PolicyStatement({
      sid: 'ReadBootstrapVersion',
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/cdk-bootstrap/hnb659fds/version`,
      ],
    }),
    new PolicyStatement({
      sid: 'ListBootstrapFileAssets',
      actions: ['s3:GetBucketLocation', 's3:ListBucket'],
      resources: [assetBucketArn],
    }),
    new PolicyStatement({
      sid: 'PublishBootstrapFileAssets',
      actions: ['s3:AbortMultipartUpload', 's3:GetObject', 's3:PutObject'],
      resources: [`${assetBucketArn}/*`],
    }),
    new PolicyStatement({
      sid: `ListExact${capitalize(resources.environment)}FrontendBucket`,
      actions: ['s3:GetBucketLocation', 's3:ListBucket'],
      resources: [frontendBucketArn],
    }),
    new PolicyStatement({
      sid: `UploadExact${capitalize(resources.environment)}FrontendBucket`,
      actions: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
      resources: [`${frontendBucketArn}/*`],
    }),
    new PolicyStatement({
      sid: `InvalidateTagged${capitalize(resources.environment)}Distributions`,
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/*`],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/Project': 'SOC_BOT',
          'aws:ResourceTag/Environment': resources.environment,
        },
      },
    }),
  ];
}

/** Defines CloudFormation permissions for environment-scoped data and analytics resources. */
export function dataAndAnalyticsStatements(resources: EnvironmentResources): PolicyStatement[] {
  const dataBucketArn = `arn:${Aws.PARTITION}:s3:::${resources.dataBucketName}`;
  return [
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}DataBuckets`,
      actions: [
        's3:CreateBucket', 's3:DeleteBucket', 's3:GetBucketLocation', 's3:GetBucketPolicy',
        's3:GetBucketTagging', 's3:GetEncryptionConfiguration', 's3:GetLifecycleConfiguration',
        's3:GetBucketPublicAccessBlock', 's3:GetBucketVersioning', 's3:ListBucket',
        's3:PutBucketPolicy', 's3:PutBucketTagging', 's3:PutEncryptionConfiguration',
        's3:PutLifecycleConfiguration', 's3:PutBucketPublicAccessBlock', 's3:PutBucketVersioning',
      ],
      resources: [`arn:${Aws.PARTITION}:s3:::soc-bot-${resources.environment}-*`],
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}DataBucketObjects`,
      actions: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
      resources: [`arn:${Aws.PARTITION}:s3:::soc-bot-${resources.environment}-*/*`],
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}GlueCatalogResources`,
      actions: [
        'glue:CreateDatabase', 'glue:CreateJob', 'glue:CreateTable', 'glue:CreateTrigger',
        'glue:DeleteDatabase', 'glue:DeleteJob', 'glue:DeleteTable', 'glue:DeleteTrigger',
        'glue:GetDatabase', 'glue:GetDatabases', 'glue:GetJob', 'glue:GetJobs', 'glue:GetTable',
        'glue:GetTables', 'glue:GetTrigger', 'glue:GetTriggers', 'glue:TagResource',
        'glue:UntagResource', 'glue:UpdateDatabase', 'glue:UpdateJob', 'glue:UpdateTable', 'glue:UpdateTrigger',
      ],
      resources: [
        `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:catalog`,
        `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:database/${resources.databasePrefix}*`,
        `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${resources.databasePrefix}*/*`,
        `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:job/${resources.prefix}-*`,
        `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:trigger/${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}AthenaWorkgroups`,
      actions: [
        'athena:CreateWorkGroup', 'athena:DeleteWorkGroup', 'athena:GetWorkGroup',
        'athena:TagResource', 'athena:UntagResource', 'athena:UpdateWorkGroup',
      ],
      resources: [
        `arn:${Aws.PARTITION}:athena:${Aws.REGION}:${Aws.ACCOUNT_ID}:workgroup/${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}LakeFormationConfiguration`,
      actions: [
        'lakeformation:DeregisterResource', 'lakeformation:GrantPermissions',
        'lakeformation:ListPermissions', 'lakeformation:RegisterResource', 'lakeformation:RevokePermissions',
      ],
      resources: ['*'],
    }),
  ];
}

/** Defines CloudFormation permissions for AI and application runtime resources. */
export function aiApplicationStatements(resources: EnvironmentResources): PolicyStatement[] {
  return [
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}LambdaFunctions`,
      actions: [
        'lambda:AddPermission', 'lambda:CreateFunction', 'lambda:CreateFunctionUrlConfig',
        'lambda:DeleteFunction', 'lambda:DeleteFunctionUrlConfig', 'lambda:GetFunction',
        'lambda:GetFunctionConfiguration', 'lambda:GetFunctionUrlConfig', 'lambda:ListTags',
        'lambda:PublishVersion', 'lambda:RemovePermission', 'lambda:TagResource', 'lambda:UntagResource',
        'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration', 'lambda:UpdateFunctionUrlConfig',
      ],
      resources: [
        `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:function:${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}DynamoDbTables`,
      actions: [
        'dynamodb:CreateTable', 'dynamodb:DeleteTable', 'dynamodb:DescribeContinuousBackups',
        'dynamodb:DescribeTable', 'dynamodb:DescribeTimeToLive', 'dynamodb:ListTagsOfResource',
        'dynamodb:TagResource', 'dynamodb:UntagResource', 'dynamodb:UpdateContinuousBackups',
        'dynamodb:UpdateTable', 'dynamodb:UpdateTimeToLive',
      ],
      resources: [
        `arn:${Aws.PARTITION}:dynamodb:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `ReadBootstrapAssetsFor${capitalize(resources.environment)}Functions`,
      actions: ['s3:GetObject'],
      resources: [
        `arn:${Aws.PARTITION}:s3:::cdk-hnb659fds-assets-${Aws.ACCOUNT_ID}-${Aws.REGION}/*`,
      ],
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}EventSchedules`,
      actions: [
        'events:DeleteRule', 'events:DescribeRule', 'events:DisableRule', 'events:EnableRule',
        'events:ListTagsForResource', 'events:ListTargetsByRule', 'events:PutRule', 'events:PutTargets',
        'events:RemoveTargets', 'events:TagResource', 'events:UntagResource',
      ],
      resources: [
        `arn:${Aws.PARTITION}:events:${Aws.REGION}:${Aws.ACCOUNT_ID}:rule/${resources.prefix}-*`,
      ],
    }),
  ];
}

/** Defines CloudFormation permissions for the frontend, API, and authentication resources. */
export function frontendApiStatements(resources: EnvironmentResources): PolicyStatement[] {
  const tagConditions = {
    StringEqualsIfExists: {
      'aws:ResourceTag/Project': 'SOC_BOT',
      'aws:ResourceTag/Environment': resources.environment,
    },
  };
  return [
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}ApiGateway`,
      actions: ['apigateway:DELETE', 'apigateway:GET', 'apigateway:PATCH', 'apigateway:POST', 'apigateway:PUT'],
      resources: [
        `arn:${Aws.PARTITION}:apigateway:${Aws.REGION}::/restapis`,
        `arn:${Aws.PARTITION}:apigateway:${Aws.REGION}::/restapis/*`,
        `arn:${Aws.PARTITION}:apigateway:${Aws.REGION}::/tags/*`,
      ],
      conditions: tagConditions,
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}CognitoUserPools`,
      actions: [
        'cognito-idp:AddCustomAttributes', 'cognito-idp:CreateUserPoolClient', 'cognito-idp:DeleteUserPool',
        'cognito-idp:DeleteUserPoolClient', 'cognito-idp:DescribeUserPool', 'cognito-idp:DescribeUserPoolClient',
        'cognito-idp:TagResource', 'cognito-idp:UntagResource', 'cognito-idp:UpdateUserPool',
        'cognito-idp:UpdateUserPoolClient',
      ],
      resources: [
        `arn:${Aws.PARTITION}:cognito-idp:${Aws.REGION}:${Aws.ACCOUNT_ID}:userpool/*`,
      ],
      conditions: tagConditions,
    }),
    new PolicyStatement({
      sid: `CreateTagged${capitalize(resources.environment)}CognitoUserPool`,
      actions: ['cognito-idp:CreateUserPool'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/Project': 'SOC_BOT',
          'aws:RequestTag/Environment': resources.environment,
          'aws:RequestTag/ManagedBy': 'CDK',
        },
      },
    }),
    new PolicyStatement({
      sid: `ManageTagged${capitalize(resources.environment)}CloudFrontDistributions`,
      actions: [
        'cloudfront:CreateDistribution', 'cloudfront:DeleteDistribution', 'cloudfront:GetDistribution',
        'cloudfront:GetDistributionConfig', 'cloudfront:TagResource', 'cloudfront:UntagResource',
        'cloudfront:UpdateDistribution',
      ],
      resources: [`arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/*`],
      conditions: tagConditions,
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}OriginAccessControls`,
      actions: [
        'cloudfront:CreateOriginAccessControl', 'cloudfront:DeleteOriginAccessControl',
        'cloudfront:GetOriginAccessControl', 'cloudfront:GetOriginAccessControlConfig',
        'cloudfront:UpdateOriginAccessControl',
      ],
      resources: ['*'],
    }),
  ];
}

/** Defines CloudFormation permissions for environment-scoped logs, alarms, and budgets. */
export function observabilityStatements(resources: EnvironmentResources): PolicyStatement[] {
  return [
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}LogGroups`,
      actions: [
        'logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:DeleteRetentionPolicy',
        'logs:DescribeLogGroups', 'logs:ListTagsForResource', 'logs:PutRetentionPolicy',
        'logs:TagResource', 'logs:UntagResource',
      ],
      resources: [
        `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}Alarms`,
      actions: [
        'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms', 'cloudwatch:PutMetricAlarm',
        'cloudwatch:TagResource', 'cloudwatch:UntagResource',
      ],
      resources: [
        `arn:${Aws.PARTITION}:cloudwatch:${Aws.REGION}:${Aws.ACCOUNT_ID}:alarm:${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}Budget`,
      actions: [
        'budgets:CreateBudgetAction', 'budgets:DeleteBudgetAction',
        'budgets:DescribeBudgetAction', 'budgets:UpdateBudgetAction',
      ],
      resources: [`arn:${Aws.PARTITION}:budgets::${Aws.ACCOUNT_ID}:budget/${resources.prefix}-*`],
    }),
  ];
}

/** Defines the constrained IAM lifecycle permissions for environment-specific runtime roles. */
export function runtimeIamStatements(resources: EnvironmentResources): PolicyStatement[] {
  const upper = resources.environment.toUpperCase();
  const runtimeRoleArn = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/SOC_BOT_${upper}_RUNTIME_*`;
  const runtimePolicyArn = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:policy/SOC_BOT_${upper}_RUNTIME_*`;
  const requiredTags = {
    'aws:RequestTag/Project': 'SOC_BOT',
    'aws:RequestTag/Environment': resources.environment,
    'aws:RequestTag/ManagedBy': 'CDK',
  };
  return [
    new PolicyStatement({
      sid: `CreateTaggedBounded${capitalize(resources.environment)}RuntimeRoles`,
      actions: ['iam:CreateRole'],
      resources: [runtimeRoleArn],
      conditions: {
        StringEquals: {
          'iam:PermissionsBoundary': resources.boundaryArn,
          ...requiredTags,
        },
        'ForAllValues:StringEquals': {
          'aws:TagKeys': ['Project', 'Environment', 'ManagedBy', 'SOCBOTAccessClass'],
        },
      },
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}RuntimeRoles`,
      actions: [
        'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:GetRole', 'iam:GetRolePolicy',
        'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies', 'iam:ListRoleTags',
        'iam:PutRolePolicy', 'iam:TagRole', 'iam:UntagRole', 'iam:UpdateAssumeRolePolicy',
        'iam:UpdateRoleDescription',
      ],
      resources: [runtimeRoleArn],
    }),
    new PolicyStatement({
      sid: `ApplyOnly${capitalize(resources.environment)}RuntimeBoundary`,
      actions: ['iam:DeleteRolePermissionsBoundary', 'iam:PutRolePermissionsBoundary'],
      resources: [runtimeRoleArn],
      conditions: {
        StringEqualsIfExists: { 'iam:PermissionsBoundary': resources.boundaryArn },
      },
    }),
    new PolicyStatement({
      sid: `CreateTagged${capitalize(resources.environment)}RuntimePolicies`,
      actions: ['iam:CreatePolicy'],
      resources: [runtimePolicyArn],
      conditions: {
        StringEquals: requiredTags,
        'ForAllValues:StringEquals': {
          'aws:TagKeys': ['Project', 'Environment', 'ManagedBy'],
        },
      },
    }),
    new PolicyStatement({
      sid: `ManageOnly${capitalize(resources.environment)}RuntimePolicies`,
      actions: [
        'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion',
        'iam:GetPolicy', 'iam:GetPolicyVersion', 'iam:ListPolicyTags', 'iam:ListPolicyVersions',
        'iam:SetDefaultPolicyVersion', 'iam:TagPolicy', 'iam:UntagPolicy',
      ],
      resources: [runtimePolicyArn],
    }),
    new PolicyStatement({
      sid: `AttachOnly${capitalize(resources.environment)}RuntimePolicies`,
      actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
      resources: [runtimeRoleArn, runtimePolicyArn],
    }),
    new PolicyStatement({
      sid: `PassOnly${capitalize(resources.environment)}RuntimeRolesToApprovedServices`,
      actions: ['iam:PassRole'],
      resources: [runtimeRoleArn],
      conditions: {
        StringEquals: {
          'iam:PassedToService': [
            'lambda.amazonaws.com', 'glue.amazonaws.com', 'apigateway.amazonaws.com',
          ],
        },
      },
    }),
  ];
}

/**
 * Defines the maximum permissions available to runtime roles, separated by access-class tags.
 * The explicit evaluation-prefix denial applies regardless of the runtime role's access class.
 */
export function runtimeBoundaryStatements(
  resources: EnvironmentResources,
  bedrockModelArn: string,
): PolicyStatement[] {
  const dataBucketArn = `arn:${Aws.PARTITION}:s3:::${resources.dataBucketName}`;
  // Produces the principal-tag condition that selects one approved runtime access class.
  const accessClass = (value: string) => ({
    StringEquals: { 'aws:PrincipalTag/SOCBOTAccessClass': value },
  });
  return [
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}RuntimeLogging`,
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*${resources.prefix}-*:*`,
      ],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}RuntimeMetrics`,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': `SOC_BOT/${resources.environment}` } },
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}ApplicationState`,
      actions: [
        'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteItem',
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem',
      ],
      resources: [
        `arn:${Aws.PARTITION}:dynamodb:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${resources.prefix}-*`,
      ],
      conditions: accessClass('application'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}ApprovedBedrockModel`,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [bedrockModelArn],
      conditions: accessClass('application'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}ApplicationFunctions`,
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:function:${resources.prefix}-*`,
      ],
      conditions: accessClass('application'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}PlaybookReads`,
      actions: ['s3:GetObject'],
      resources: [`${dataBucketArn}/playbooks/*`],
      conditions: accessClass('application'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}CognitoAuthentication`,
      actions: ['cognito-idp:AdminInitiateAuth', 'cognito-idp:AdminRespondToAuthChallenge'],
      resources: [
        `arn:${Aws.PARTITION}:cognito-idp:${Aws.REGION}:${Aws.ACCOUNT_ID}:userpool/*`,
      ],
      conditions: accessClass('application'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}DedicatedAthenaQueries`,
      actions: [
        'athena:GetQueryExecution', 'athena:GetQueryResults',
        'athena:StartQueryExecution', 'athena:StopQueryExecution',
      ],
      resources: [
        `arn:${Aws.PARTITION}:athena:${Aws.REGION}:${Aws.ACCOUNT_ID}:workgroup/${resources.prefix}-*`,
      ],
      conditions: accessClass('query'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}QueryCatalogMetadata`,
      actions: ['glue:GetDatabase', 'glue:GetDatabases', 'glue:GetTable', 'glue:GetTables', 'glue:GetPartitions'],
      resources: glueCatalogResources(resources),
      conditions: accessClass('query'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}LakeFormationDataAccess`,
      actions: ['lakeformation:GetDataAccess'],
      resources: ['*'],
      conditions: accessClass('query'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}AthenaResultAccess`,
      actions: ['s3:AbortMultipartUpload', 's3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:PutObject'],
      resources: [dataBucketArn, `${dataBucketArn}/athena-results/*`],
      conditions: accessClass('query'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}GlueCatalogWrites`,
      actions: [
        'glue:BatchCreatePartition', 'glue:BatchDeletePartition', 'glue:BatchGetPartition',
        'glue:CreatePartition', 'glue:GetDatabase', 'glue:GetPartition', 'glue:GetPartitions',
        'glue:GetTable', 'glue:UpdatePartition', 'glue:UpdateTable',
      ],
      resources: glueCatalogResources(resources),
      conditions: accessClass('glue'),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}GlueSourceAndDestinationPrefixes`,
      actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [
        dataBucketArn,
        `${dataBucketArn}/raw/*`,
        `${dataBucketArn}/normalized/*`,
        `${dataBucketArn}/quarantine/*`,
      ],
      conditions: accessClass('glue'),
    }),
    new PolicyStatement({
      sid: `Deny${capitalize(resources.environment)}EvaluationGroundTruth`,
      effect: Effect.DENY,
      actions: ['s3:*'],
      resources: [`${dataBucketArn}/evaluation`, `${dataBucketArn}/evaluation/*`],
    }),
  ];
}

/** Returns the Glue catalog, database, and table ARNs for one environment. */
function glueCatalogResources(resources: EnvironmentResources): string[] {
  return [
    `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:catalog`,
    `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:database/${resources.databasePrefix}*`,
    `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${resources.databasePrefix}*/*`,
  ];
}

/** Uppercases the first character for readable IAM statement identifiers. */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
