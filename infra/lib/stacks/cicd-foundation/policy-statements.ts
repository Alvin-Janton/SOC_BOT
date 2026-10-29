import { Aws } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { chatApiAccessLogGroupName, dataBucketName, DeploymentEnvironment, frontendApiAccessLogGroupName, frontendBucketName, frontendOriginSecretArn, glueFileBucketName } from '../../shared/environment';

export const RUNTIME_CLASSES = ['application', 'query', 'glue'] as const;
export type RuntimeClass = typeof RUNTIME_CLASSES[number];

/** Returns the administrator-managed boundary ARN for an environment and runtime class. */
export function runtimeBoundaryArn(environment: DeploymentEnvironment, runtimeClass: RuntimeClass): string {
  return `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:policy/SOC_BOT_${environment.toUpperCase()}_BOUNDARY_${runtimeClass.toUpperCase()}`;
}

export const BEDROCK_INFERENCE_PROFILE = {
  profileId: 'us.anthropic.claude-sonnet-4-6',
  foundationModelId: 'anthropic.claude-sonnet-4-6',
  sourceRegion: 'us-east-1',
} as const;

export interface EnvironmentResources {
  readonly environment: DeploymentEnvironment;
  readonly prefix: string;
  readonly databasePrefix: string;
  readonly dataBucketName: string;
  readonly frontendBucketName: string;
  readonly executionRoleArn: string;
}

/** Builds deterministic, environment-qualified names and ARNs used by IAM policies. */
export function environmentResources(environment: DeploymentEnvironment): EnvironmentResources {
  const upper = environment.toUpperCase();
  return {
    environment,
    prefix: `SOC-BOT-${upper}`,
    databasePrefix: `soc_bot_${environment}`,
    dataBucketName: dataBucketName(environment),
    frontendBucketName: frontendBucketName(environment),
    executionRoleArn: `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/SOC_BOT_${upper}_CFN_EXEC`,
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
  const glueAssetBucketArn = `arn:${Aws.PARTITION}:s3:::${glueFileBucketName(resources.environment)}`;
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
      sid: `List${capitalize(resources.environment)}GlueFileAssets`,
      actions: ['s3:GetBucketLocation', 's3:ListBucket'],
      resources: [glueAssetBucketArn],
    }),
    new PolicyStatement({
      sid: `Publish${capitalize(resources.environment)}GlueFileAssets`,
      actions: ['s3:AbortMultipartUpload', 's3:GetObject', 's3:PutObject'],
      resources: [`${glueAssetBucketArn}/glue/*`],
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
  return [
    new PolicyStatement({
      sid: `Protect${capitalize(resources.environment)}AdministratorGlueFileBucket`,
      effect: Effect.DENY,
      actions: [
        's3:CreateBucket', 's3:DeleteBucket', 's3:DeleteBucketPolicy',
        's3:PutBucketPolicy', 's3:PutBucketTagging', 's3:PutEncryptionConfiguration',
        's3:PutBucketPublicAccessBlock', 's3:PutBucketVersioning',
        's3:PutLifecycleConfiguration', 's3:PutObject', 's3:DeleteObject',
      ],
      resources: [
        `arn:${Aws.PARTITION}:s3:::${glueFileBucketName(resources.environment)}`,
        `arn:${Aws.PARTITION}:s3:::${glueFileBucketName(resources.environment)}/*`,
      ],
    }),
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}DataBuckets`,
      actions: [
        's3:CreateBucket', 's3:DeleteBucket', 's3:DeleteBucketPolicy', 's3:GetBucketLocation', 's3:GetBucketPolicy',
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
    ...(resources.environment === 'dev' ? [
      new PolicyStatement({
        sid: 'DeleteDevGlueDatabaseUserDefinedFunctions',
        actions: ['glue:DeleteDatabase'],
        resources: [
          `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:userDefinedFunction/${resources.databasePrefix}*/*`,
        ],
      }),
    ] : []),
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
      sid: `Read${capitalize(resources.environment)}LakeFormationServiceLinkedRole`,
      actions: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:PutRolePolicy'],
      resources: [
        `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/aws-service-role/lakeformation.amazonaws.com/AWSServiceRoleForLakeFormationDataAccess`,
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
    ...cognitoUserPoolStatements(resources),
  ];
}

/** Keeps Cognito lifecycle/tag permissions in the application policy to respect managed-policy size limits. */
function cognitoUserPoolStatements(resources: EnvironmentResources): PolicyStatement[] {
  const title = capitalize(resources.environment);
  const userPoolArn = `arn:${Aws.PARTITION}:cognito-idp:${Aws.REGION}:${Aws.ACCOUNT_ID}:userpool/*`;
  const ownership = { Project: 'SOC_BOT', Environment: resources.environment, ManagedBy: 'CDK' };
  const resourceTags = Object.fromEntries(Object.entries(ownership).map(([key, value]) => [`aws:ResourceTag/${key}`, value]));
  const systemTagKeys = [
    'aws:cloudformation:stack-id',
    'aws:cloudformation:stack-name',
    'aws:cloudformation:logical-id',
  ];
  const requestConditions = {
    StringEquals: Object.fromEntries(Object.entries(ownership).map(([key, value]) => [`aws:RequestTag/${key}`, value])),
    'ForAllValues:StringEquals': { 'aws:TagKeys': [...Object.keys(ownership), ...systemTagKeys] },
  };
  return [
    new PolicyStatement({
      sid: `ManageTagged${title}CognitoUserPools`,
      actions: [
        'cognito-idp:AddCustomAttributes', 'cognito-idp:CreateUserPoolClient', 'cognito-idp:DeleteUserPool',
        'cognito-idp:DeleteUserPoolClient', 'cognito-idp:DescribeUserPool', 'cognito-idp:DescribeUserPoolClient',
        'cognito-idp:ListTagsForResource', 'cognito-idp:UpdateUserPool', 'cognito-idp:UpdateUserPoolClient',
      ],
      resources: [userPoolArn],
      conditions: { StringEquals: resourceTags },
    }),
    new PolicyStatement({
      sid: `CreateTagged${title}CognitoUserPool`,
      actions: ['cognito-idp:CreateUserPool'], resources: ['*'],
      conditions: { ...requestConditions,
        StringEquals: { ...requestConditions.StringEquals, 'aws:RequestedRegion': Aws.REGION } },
    }),
    new PolicyStatement({
      sid: `Tag${title}CognitoUserPools`,
      actions: ['cognito-idp:TagResource'], resources: [userPoolArn], conditions: requestConditions,
    }),
    // Deny each mismatching existing ownership tag separately; absent tags must not block creation.
    ...Object.entries(ownership).map(([key, value]) => new PolicyStatement({
      sid: `Deny${title}Cognito${key}Retagging`,
      effect: Effect.DENY,
      actions: ['cognito-idp:TagResource'], resources: [userPoolArn],
      conditions: {
        Null: { [`aws:ResourceTag/${key}`]: 'false' },
        StringNotEquals: { [`aws:ResourceTag/${key}`]: value },
      },
    })),
    new PolicyStatement({
      sid: `Untag${title}CognitoSystemTags`,
      actions: ['cognito-idp:UntagResource'], resources: [userPoolArn],
      // UntagResource supports existing resource tags and TagKeys, not request-tag values.
      conditions: {
        StringEquals: resourceTags,
        'ForAllValues:StringEquals': { 'aws:TagKeys': systemTagKeys },
        Null: { 'aws:TagKeys': 'false' },
      },
    }),
    new PolicyStatement({
      sid: `Protect${title}CognitoOwnershipTags`,
      effect: Effect.DENY,
      actions: ['cognito-idp:UntagResource'], resources: [userPoolArn],
      conditions: {
        StringEquals: resourceTags,
        'ForAnyValue:StringEquals': { 'aws:TagKeys': Object.keys(ownership) },
      },
    }),
  ];
}

/** Defines CloudFormation permissions for frontend and API resources without shared tag exceptions. */
export function frontendApiStatements(resources: EnvironmentResources): PolicyStatement[] {
  const title = capitalize(resources.environment);
  const requiredRequestTags = {
    StringEquals: {
      'aws:RequestTag/Project': 'SOC_BOT',
      'aws:RequestTag/Environment': resources.environment,
      'aws:RequestTag/ManagedBy': 'CDK',
    },
    'ForAllValues:StringEquals': {
      'aws:TagKeys': ['Project', 'Environment', 'ManagedBy'],
    },
  };
  const requiredResourceTags = {
    StringEquals: {
      'aws:ResourceTag/Project': 'SOC_BOT',
      'aws:ResourceTag/Environment': resources.environment,
      'aws:ResourceTag/ManagedBy': 'CDK',
    },
  };
  // WAF receives CloudFormation system tags; other services keep their existing allowlist.
  const requiredWafRequestTags = {
    ...requiredRequestTags,
    'ForAllValues:StringEquals': {
      'aws:TagKeys': [
        ...requiredRequestTags['ForAllValues:StringEquals']['aws:TagKeys'],
        'aws:cloudformation:stack-id',
        'aws:cloudformation:stack-name',
        'aws:cloudformation:logical-id',
      ],
    },
  };
  const apiGatewayArn = `arn:${Aws.PARTITION}:apigateway:${Aws.REGION}::/restapis`;
  const distributionArn = `arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/*`;
  const devIpSetArn = `arn:${Aws.PARTITION}:wafv2:${Aws.REGION}:${Aws.ACCOUNT_ID}:regional/ipset/SOC-BOT-DEV-CHAT-CLIENTS/*`;
  const devWebAclArn = `arn:${Aws.PARTITION}:wafv2:${Aws.REGION}:${Aws.ACCOUNT_ID}:regional/webacl/SOC-BOT-DEV-CHAT-ALLOWLIST/*`;
  return [
    new PolicyStatement({
      sid: `CreateTagged${title}ApiGateway`,
      actions: ['apigateway:POST'],
      resources: [apiGatewayArn],
      conditions: requiredRequestTags,
    }),
    new PolicyStatement({
      sid: `ManageTagged${title}ApiGateway`,
      actions: ['apigateway:DELETE', 'apigateway:GET', 'apigateway:PATCH', 'apigateway:POST', 'apigateway:PUT'],
      resources: [`${apiGatewayArn}/*`],
      conditions: requiredResourceTags,
    }),
    new PolicyStatement({
      sid: `Tag${title}ApiGateway`,
      actions: ['apigateway:PUT'],
      resources: [`arn:${Aws.PARTITION}:apigateway:${Aws.REGION}::/tags/*`],
      conditions: requiredRequestTags,
    }),
    ...(resources.environment === 'dev' ? [
      new PolicyStatement({
        sid: 'SetDevChatStageWebAcl',
        actions: ['apigateway:SetWebACL'],
        resources: [`${apiGatewayArn}/*/stages/dev`],
        // Approved dev-only exception: WAF association may omit stage tags from authorization context.
        conditions: { StringEqualsIfExists: requiredResourceTags.StringEquals },
      }),
      new PolicyStatement({
        sid: 'CreateTaggedDevChatWafResources',
        // WebACL creation also authorizes the IPSet referenced by its single allowlist rule.
        actions: ['wafv2:CreateIPSet', 'wafv2:CreateWebACL'],
        resources: [devIpSetArn, devWebAclArn], conditions: requiredWafRequestTags,
      }),
      new PolicyStatement({
        sid: 'ManageTaggedDevChatIpSet',
        actions: ['wafv2:CreateWebACL', 'wafv2:DeleteIPSet', 'wafv2:UpdateIPSet'],
        resources: [devIpSetArn], conditions: requiredResourceTags,
      }),
      new PolicyStatement({
        sid: 'ManageTaggedDevChatWebAcl',
        actions: ['wafv2:AssociateWebACL', 'wafv2:DeleteWebACL', 'wafv2:UpdateWebACL'],
        // UpdateWebACL authorizes referenced IPSets as well as the WebACL itself.
        resources: [devWebAclArn, devIpSetArn], conditions: requiredResourceTags,
      }),
      new PolicyStatement({
        sid: 'TagDevChatWafResources',
        actions: ['wafv2:TagResource'], resources: [devIpSetArn, devWebAclArn], conditions: requiredWafRequestTags,
      }),
      new PolicyStatement({
        sid: 'ReadDevChatWafTags',
        // CloudFormation must be able to inspect absence after a tagged resource is deleted.
        actions: ['wafv2:GetIPSet', 'wafv2:GetWebACL', 'wafv2:ListTagsForResource'],
        resources: [devIpSetArn, devWebAclArn],
      }),
      new PolicyStatement({
        sid: 'ReadDevWebAclAssociation',
        // API Gateway association lookup requires GetWebACL and the Regional WebACL wildcard.
        actions: ['wafv2:GetWebACLForResource', 'wafv2:GetWebACL'],
        resources: [`arn:${Aws.PARTITION}:wafv2:${Aws.REGION}:${Aws.ACCOUNT_ID}:regional/webacl/*/*`],
      }),
    ] : []),
    new PolicyStatement({
      sid: `CreateTagged${title}CloudFrontDistribution`,
      actions: ['cloudfront:CreateDistribution', 'cloudfront:TagResource'],
      resources: ['*'],
      conditions: requiredRequestTags,
    }),
    new PolicyStatement({
      sid: `ManageTagged${title}CloudFrontDistributions`,
      actions: [
        'cloudfront:DeleteDistribution', 'cloudfront:GetDistribution',
        'cloudfront:GetDistributionConfig', 'cloudfront:ListTagsForResource', 'cloudfront:UpdateDistribution',
      ],
      resources: [distributionArn],
      conditions: requiredResourceTags,
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

/** Limits new global WAF access to the dev frontend names, without altering Regional chat permissions. */
export function frontendWafStatements(resources: EnvironmentResources): PolicyStatement[] {
  if (resources.environment !== 'dev') return [];
  const ipSet = `arn:${Aws.PARTITION}:wafv2:us-east-1:${Aws.ACCOUNT_ID}:global/ipset/SOC-BOT-DEV-FRONTEND-CLIENTS/*`;
  const webAcl = `arn:${Aws.PARTITION}:wafv2:us-east-1:${Aws.ACCOUNT_ID}:global/webacl/SOC-BOT-DEV-FRONTEND-ALLOWLIST/*`;
  const ownership = { Project: 'SOC_BOT', Environment: 'dev', ManagedBy: 'CDK' };
  const resourceTags = { StringEquals: Object.fromEntries(Object.entries(ownership).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) };
  const requestTags = {
    StringEquals: Object.fromEntries(Object.entries(ownership).map(([key, value]) => [`aws:RequestTag/${key}`, value])),
    'ForAllValues:StringEquals': { 'aws:TagKeys': [
      ...Object.keys(ownership), 'aws:cloudformation:stack-id', 'aws:cloudformation:stack-name', 'aws:cloudformation:logical-id',
    ] },
  };
  return [
    new PolicyStatement({ sid: 'CreateTaggedDevFrontendWaf', actions: ['wafv2:CreateIPSet', 'wafv2:CreateWebACL'],
      resources: [ipSet, webAcl], conditions: requestTags }),
    new PolicyStatement({ sid: 'ManageTaggedDevFrontendIpSet',
      actions: ['wafv2:CreateWebACL', 'wafv2:DeleteIPSet', 'wafv2:UpdateIPSet'], resources: [ipSet], conditions: resourceTags }),
    new PolicyStatement({ sid: 'ManageTaggedDevFrontendWebAcl',
      actions: ['wafv2:DeleteWebACL', 'wafv2:UpdateWebACL'], resources: [webAcl, ipSet], conditions: resourceTags }),
    new PolicyStatement({ sid: 'TagDevFrontendWaf', actions: ['wafv2:TagResource'], resources: [ipSet, webAcl], conditions: requestTags }),
    new PolicyStatement({ sid: 'ReadDevFrontendWaf', actions: ['wafv2:GetIPSet', 'wafv2:GetWebACL', 'wafv2:ListTagsForResource'],
      resources: [ipSet, webAcl] }),
  ];
}

/** Grants only the frontend origin-secret lifecycle, preserving demo retention and protected ownership tags. */
export function frontendOriginSecretStatements(resources: EnvironmentResources): PolicyStatement[] {
  const title = capitalize(resources.environment);
  const secretArn = frontendOriginSecretArn(resources.environment);
  const ownership = { Project: 'SOC_BOT', Environment: resources.environment, ManagedBy: 'CDK' };
  const resourceTags = { StringEquals: Object.fromEntries(Object.entries(ownership).map(([key, value]) => [`aws:ResourceTag/${key}`, value])) };
  const systemKeys = ['aws:cloudformation:stack-id', 'aws:cloudformation:stack-name', 'aws:cloudformation:logical-id'];
  return [
    new PolicyStatement({ sid: `CreateTag${title}FrontendOriginSecret`, actions: ['secretsmanager:CreateSecret', 'secretsmanager:TagResource'],
      resources: [secretArn], conditions: {
        StringEquals: Object.fromEntries(Object.entries(ownership).map(([key, value]) => [`aws:RequestTag/${key}`, value])),
        'ForAllValues:StringEquals': { 'aws:TagKeys': [...Object.keys(ownership), ...systemKeys] },
      } }),
    new PolicyStatement({ sid: `Read${title}FrontendOriginSecret`,
      actions: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'], resources: [secretArn] }),
    new PolicyStatement({ sid: `Update${title}FrontendOriginSecret`,
      actions: ['secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret',
        ...(resources.environment === 'dev' ? ['secretsmanager:DeleteSecret'] : [])],
      resources: [secretArn], conditions: resourceTags }),
    new PolicyStatement({ sid: `Untag${title}FrontendOriginSystemTags`, actions: ['secretsmanager:UntagResource'],
      resources: [secretArn], conditions: { ...resourceTags,
        'ForAllValues:StringEquals': { 'aws:TagKeys': systemKeys }, Null: { 'aws:TagKeys': 'false' },
      } }),
    new PolicyStatement({ sid: `Protect${title}FrontendOriginTags`, effect: Effect.DENY, actions: ['secretsmanager:UntagResource'],
      resources: [secretArn], conditions: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': Object.keys(ownership) } } }),
    new PolicyStatement({ sid: `Generate${title}FrontendOriginToken`, actions: ['secretsmanager:GetRandomPassword'],
      resources: ['*'], conditions: { StringEquals: { 'aws:RequestedRegion': Aws.REGION } } }),
  ];
}

/** Defines CloudFormation permissions for environment-scoped logs, alarms, and budgets. */
export function observabilityStatements(resources: EnvironmentResources): PolicyStatement[] {
  const executionLogGroupArn = `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:API-Gateway-Execution-Logs_*/${resources.environment}`;
  const ownership = { Project: 'SOC_BOT', Environment: resources.environment, ManagedBy: 'CDK' };
  return [
    new PolicyStatement({
      sid: `Manage${capitalize(resources.environment)}LogGroups`,
      actions: [
        'logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:DeleteRetentionPolicy',
        'logs:ListTagsForResource', 'logs:PutRetentionPolicy',
        'logs:TagResource', 'logs:UntagResource',
      ],
      resources: [
        `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `CreateTagged${capitalize(resources.environment)}ApiExecutionLogs`,
      actions: ['logs:CreateLogGroup', 'logs:TagResource'],
      resources: [executionLogGroupArn, `${executionLogGroupArn}:*`],
      conditions: {
        StringEquals: Object.fromEntries(Object.entries(ownership).map(([key, value]) => [`aws:RequestTag/${key}`, value])),
        'ForAllValues:StringEquals': { 'aws:TagKeys': [
          ...Object.keys(ownership),
          'aws:cloudformation:stack-id',
          'aws:cloudformation:stack-name',
          'aws:cloudformation:logical-id',
        ] },
      },
    }),
    new PolicyStatement({
      sid: `ManageTagged${capitalize(resources.environment)}ApiExecutionLogs`,
      actions: [
        ...(resources.environment === 'demo' ? ['logs:DeleteLogGroup'] : []),
        'logs:DeleteRetentionPolicy', 'logs:ListTagsForResource', 'logs:PutRetentionPolicy',
      ],
      resources: [executionLogGroupArn, `${executionLogGroupArn}:*`],
      conditions: {
        StringEquals: Object.fromEntries(Object.entries(ownership).map(([key, value]) => [`aws:ResourceTag/${key}`, value])),
      },
    }),
    ...(resources.environment === 'dev' ? [new PolicyStatement({
      sid: 'DeleteDevApiExecutionLogs',
      actions: ['logs:DeleteLogGroup'],
      resources: [executionLogGroupArn, `${executionLogGroupArn}:*`],
      conditions: {
        StringEqualsIfExists: {
          'aws:ResourceTag/Project': 'SOC_BOT',
          'aws:ResourceTag/Environment': 'dev',
          'aws:ResourceTag/ManagedBy': 'CDK',
        },
      },
    })] : []),
    new PolicyStatement({
      sid: `Describe${capitalize(resources.environment)}LogGroups`,
      actions: ['logs:DescribeLogGroups'],
      resources: ['*'],
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
        'budgets:ListTagsForResource', 'budgets:ModifyBudget', 'budgets:TagResource',
        'budgets:UntagResource', 'budgets:ViewBudget',
      ],
      resources: [`arn:${Aws.PARTITION}:budgets::${Aws.ACCOUNT_ID}:budget/${resources.prefix}-*`],
    }),
  ];
}

/** Limits the shared API Gateway service role to each environment's access/execution logs. */
export function apiGatewayLoggingStatements(environment: DeploymentEnvironment): PolicyStatement[] {
  const prefix = `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:`;
  const logGroups = [
    `${prefix}${chatApiAccessLogGroupName(environment)}`,
    `${prefix}${frontendApiAccessLogGroupName(environment)}`,
    `${prefix}API-Gateway-Execution-Logs_*/${environment}`,
  ];
  return [new PolicyStatement({
    actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogStreams',
      'logs:PutLogEvents', 'logs:GetLogEvents', 'logs:FilterLogEvents'],
    resources: logGroups.map((arn) => `${arn}:*`),
  })];
}

/** Defines the constrained IAM lifecycle permissions for environment-specific runtime roles. */
export function runtimeIamStatements(resources: EnvironmentResources): PolicyStatement[] {
  const prefix = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:`;
  const namespace = `SOC_BOT_${resources.environment.toUpperCase()}`;
  const roleArns = RUNTIME_CLASSES.map((kind) => `${prefix}role/${namespace}_RUNTIME_${kind.toUpperCase()}_*`);
  const policyArn = `${prefix}policy/${namespace}_RUNTIME_POLICY_*`;
  const ownership = { Project: 'SOC_BOT', Environment: resources.environment, ManagedBy: 'CDK' };
  const protectedKeys = [...Object.keys(ownership), 'SOCBOTAccessClass'];
  const statements: PolicyStatement[] = [];
  for (const [index, kind] of RUNTIME_CLASSES.entries()) {
    const tags = { ...ownership, SOCBOTAccessClass: kind };
    const requestTags = Object.fromEntries(Object.entries(tags).map(([key, value]) => [`aws:RequestTag/${key}`, value]));
    const resourceTags = Object.fromEntries(Object.entries(tags).map(([key, value]) => [`aws:ResourceTag/${key}`, value]));
    statements.push(
      new PolicyStatement({
        actions: ['iam:CreateRole'], resources: [roleArns[index]],
        conditions: {
          StringEquals: { ...requestTags, 'iam:PermissionsBoundary': runtimeBoundaryArn(resources.environment, kind) },
          'ForAllValues:StringEquals': { 'aws:TagKeys': protectedKeys },
        },
      }),
      new PolicyStatement({
        actions: ['iam:PutRolePermissionsBoundary'], resources: [roleArns[index]],
        conditions: { StringEquals: { ...resourceTags, 'iam:PermissionsBoundary': runtimeBoundaryArn(resources.environment, kind) } },
      }),
    );
  }
  // Existing roles must resend the complete protected tag set unchanged. Creation has no existing tags.
  // Denials cover the environment's project roles; Allow statements remain class-namespace scoped.
  for (const key of protectedKeys) {
    statements.push(new PolicyStatement({
      effect: Effect.DENY, actions: ['iam:TagRole'], resources: [`${prefix}role/${namespace}_*`],
      conditions: {
        Null: { [`aws:ResourceTag/${key}`]: 'false' },
        StringNotEquals: { [`aws:ResourceTag/${key}`]: '${aws:RequestTag/' + key + '}' },
      },
    }));
  }
  return [
    ...statements,
    new PolicyStatement({
      effect: Effect.DENY, actions: ['iam:UntagRole'], resources: [`${prefix}role/${namespace}_*`],
      conditions: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': protectedKeys } },
    }),
    new PolicyStatement({
      actions: [
        'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:GetRole', 'iam:GetRolePolicy',
        'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies', 'iam:ListRoleTags',
        'iam:PutRolePolicy', 'iam:TagRole', 'iam:UntagRole', 'iam:UpdateAssumeRolePolicy',
        'iam:UpdateRoleDescription', 'iam:DeleteRolePermissionsBoundary',
      ],
      resources: roleArns,
    }),
    new PolicyStatement({
      actions: ['iam:CreatePolicy'], resources: [policyArn],
      conditions: {
        StringEquals: Object.fromEntries(Object.entries(ownership).map(([key, value]) => [`aws:RequestTag/${key}`, value])),
        'ForAllValues:StringEquals': { 'aws:TagKeys': Object.keys(ownership) },
      },
    }),
    new PolicyStatement({
      actions: [
        'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion',
        'iam:GetPolicy', 'iam:GetPolicyVersion', 'iam:ListPolicyTags', 'iam:ListPolicyVersions',
        'iam:SetDefaultPolicyVersion', 'iam:TagPolicy', 'iam:UntagPolicy',
      ],
      resources: [policyArn],
    }),
    new PolicyStatement({
      effect: Effect.DENY,
      actions: ['iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion',
        'iam:SetDefaultPolicyVersion', 'iam:TagPolicy', 'iam:UntagPolicy'],
      resources: [`${prefix}policy/${namespace}_BOUNDARY_*`],
    }),
    new PolicyStatement({
      actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], resources: roleArns,
      conditions: { ArnLike: { 'iam:PolicyARN': policyArn } },
    }),
    new PolicyStatement({
      actions: ['iam:PassRole'], resources: roleArns,
      conditions: { StringEquals: { 'iam:PassedToService': [
        'lambda.amazonaws.com', 'glue.amazonaws.com', 'apigateway.amazonaws.com',
      ] } },
    }),
  ];
}

/**
 * Defines maximum permissions for one runtime class; tags are inventory metadata only.
 * The explicit evaluation-prefix denial applies regardless of the runtime role's access class.
 */
export function runtimeBoundaryStatements(
  resources: EnvironmentResources,
  runtimeClass: RuntimeClass,
): PolicyStatement[] {
  const dataBucketArn = `arn:${Aws.PARTITION}:s3:::${resources.dataBucketName}`;
  const inferenceProfileArn = `arn:${Aws.PARTITION}:bedrock:${BEDROCK_INFERENCE_PROFILE.sourceRegion}:${Aws.ACCOUNT_ID}:inference-profile/${BEDROCK_INFERENCE_PROFILE.profileId}`;
  const foundationModelArn = `arn:${Aws.PARTITION}:bedrock:*::foundation-model/${BEDROCK_INFERENCE_PROFILE.foundationModelId}`;
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
    ...(runtimeClass === 'application' ? [new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}ApplicationState`,
      actions: [
        'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteItem',
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem',
      ],
      resources: [
        `arn:${Aws.PARTITION}:dynamodb:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}AuthSessionConditionChecks`,
      actions: ['dynamodb:ConditionCheckItem'],
      resources: [`arn:${Aws.PARTITION}:dynamodb:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${resources.prefix}-AUTH-SESSIONS`],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}FrontendOriginSecret`,
      actions: ['secretsmanager:GetSecretValue'], resources: [frontendOriginSecretArn(resources.environment)],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}ApprovedBedrockInferenceProfile`,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [inferenceProfileArn],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}ApprovedBedrockInferenceProfileRead`,
      actions: ['bedrock:GetInferenceProfile'],
      resources: [inferenceProfileArn],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}ApprovedBedrockProfileModels`,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [foundationModelArn],
      conditions: {
        StringEquals: {
          'bedrock:InferenceProfileArn': inferenceProfileArn,
        },
      },
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}ApplicationFunctions`,
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:function:${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}PlaybookReads`,
      actions: ['s3:GetObject'],
      resources: [`${dataBucketArn}/playbooks/*`],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}CognitoAuthentication`,
      actions: ['cognito-idp:AdminInitiateAuth', 'cognito-idp:AdminRespondToAuthChallenge', 'cognito-idp:AdminGetUser'],
      resources: [
        `arn:${Aws.PARTITION}:cognito-idp:${Aws.REGION}:${Aws.ACCOUNT_ID}:userpool/*`,
      ],
      conditions: { StringEquals: {
        'aws:ResourceTag/Project': 'SOC_BOT',
        'aws:ResourceTag/Environment': resources.environment,
        'aws:ResourceTag/ManagedBy': 'CDK',
      } },
    }),
    ] : []),
    ...(runtimeClass === 'query' ? [new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}DedicatedAthenaQueries`,
      actions: [
        'athena:GetQueryExecution', 'athena:GetQueryResults',
        'athena:StartQueryExecution', 'athena:StopQueryExecution',
      ],
      resources: [
        `arn:${Aws.PARTITION}:athena:${Aws.REGION}:${Aws.ACCOUNT_ID}:workgroup/${resources.prefix}-*`,
      ],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}QueryCatalogMetadata`,
      actions: ['glue:GetDatabase', 'glue:GetDatabases', 'glue:GetTable', 'glue:GetTables', 'glue:GetPartitions'],
      resources: glueCatalogResources(resources),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}LakeFormationDataAccess`,
      actions: ['lakeformation:GetDataAccess'],
      resources: ['*'],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}QueryBucketLocation`,
      actions: ['s3:GetBucketLocation'],
      resources: [dataBucketArn],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}AthenaResultListing`,
      actions: ['s3:ListBucket'],
      resources: [dataBucketArn],
      conditions: {
        StringLike: { 's3:prefix': ['athena-results', 'athena-results/*'] },
      },
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}AthenaResultObjects`,
      actions: ['s3:AbortMultipartUpload', 's3:GetObject', 's3:PutObject'],
      resources: [`${dataBucketArn}/athena-results/*`],
    }),
    ] : []),
    ...(runtimeClass === 'glue' ? [new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}GlueFileAssets`,
      actions: ['s3:GetObject'],
      resources: [`arn:${Aws.PARTITION}:s3:::${glueFileBucketName(resources.environment)}/glue/*`],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}GlueCatalogWrites`,
      actions: [
        'glue:BatchCreatePartition', 'glue:BatchDeletePartition', 'glue:BatchGetPartition',
        'glue:CreatePartition', 'glue:GetDatabase', 'glue:GetPartition', 'glue:GetPartitions',
        'glue:GetTable', 'glue:UpdatePartition', 'glue:UpdateTable',
      ],
      resources: glueCatalogResources(resources),
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}GlueBucketLocation`,
      actions: ['s3:GetBucketLocation'],
      resources: [dataBucketArn],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}GluePrefixListing`,
      actions: ['s3:ListBucket'],
      resources: [dataBucketArn],
      conditions: {
        StringLike: {
          's3:prefix': ['raw', 'raw/*', 'normalized', 'normalized/*', 'quarantine', 'quarantine/*'],
        },
      },
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}GlueSourceReads`,
      actions: ['s3:GetObject'],
      resources: [`${dataBucketArn}/raw/*`],
    }),
    new PolicyStatement({
      sid: `Allow${capitalize(resources.environment)}GlueDestinationObjects`,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [
        `${dataBucketArn}/normalized/*`,
        `${dataBucketArn}/quarantine/*`,
      ],
    }),
    ] : []),
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
