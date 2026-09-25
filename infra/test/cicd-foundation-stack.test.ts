import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CicdFoundationStack } from '../lib/cicd-foundation-stack';
import { BEDROCK_INFERENCE_PROFILE } from '../lib/policy-statements';

type JsonObject = Record<string, any>;

/** Synthesizes a fresh foundation stack and returns its assertion-friendly template. */
function synthesize(): { stack: CicdFoundationStack; template: JsonObject } {
  const app = new App();
  const stack = new CicdFoundationStack(app, 'TestCicdFoundationStack', {
    stackName: 'SOC-BOT-CICD-FOUNDATION',
    env: { region: 'us-east-1' },
  });
  return { stack, template: Template.fromStack(stack).toJSON() as JsonObject };
}

/** Selects every synthesized CloudFormation resource with the requested type. */
function resourcesOfType(template: JsonObject, type: string): JsonObject[] {
  return (Object.values(template.Resources) as JsonObject[])
    .filter((resource) => resource.Type === type);
}

/** Finds an IAM role by its exact physical name and fails clearly when it is absent. */
function roleByName(template: JsonObject, roleName: string): JsonObject {
  const role = resourcesOfType(template, 'AWS::IAM::Role')
    .find((resource) => resource.Properties.RoleName === roleName);
  if (!role) {
    throw new Error(`Missing role ${roleName}`);
  }
  return role;
}

/** Finds a customer-managed IAM policy by its exact physical name. */
function managedPolicyByName(template: JsonObject, policyName: string): JsonObject {
  const policy = resourcesOfType(template, 'AWS::IAM::ManagedPolicy')
    .find((resource) => resource.Properties.ManagedPolicyName === policyName);
  if (!policy) {
    throw new Error(`Missing managed policy ${policyName}`);
  }
  return policy;
}

/** Collects statements from both managed policies and role inline policies. */
function statements(template: JsonObject): JsonObject[] {
  const managed = resourcesOfType(template, 'AWS::IAM::ManagedPolicy')
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement);
  const inline = resourcesOfType(template, 'AWS::IAM::Role')
    .flatMap((resource) => resource.Properties.Policies ?? [])
    .flatMap((policy: JsonObject) => policy.PolicyDocument.Statement);
  return [...managed, ...inline];
}

/** Normalizes a policy statement's Action property to an array for inspection. */
function actions(statement: JsonObject): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

/** Finds a statement by SID within a synthesized managed policy. */
function statementBySid(policy: JsonObject, sid: string): JsonObject {
  const statement = policy.Properties.PolicyDocument.Statement
    .find((candidate: JsonObject) => candidate.Sid === sid);
  if (!statement) {
    throw new Error(`Missing statement ${sid}`);
  }
  return statement;
}

describe('CicdFoundationStack', () => {
  // Verifies the shared identity provider and fixed foundation-role count.
  test('creates one native OIDC provider and exactly four roles', () => {
    const { stack, template } = synthesize();
    expect(stack.stackName).toBe('SOC-BOT-CICD-FOUNDATION');
    expect(resourcesOfType(template, 'AWS::IAM::OIDCProvider')).toHaveLength(1);
    expect(resourcesOfType(template, 'AWS::IAM::Role')).toHaveLength(4);

    const provider = resourcesOfType(template, 'AWS::IAM::OIDCProvider')[0];
    expect(provider.Properties).toMatchObject({
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
      Tags: expect.arrayContaining([
        { Key: 'Project', Value: 'SOC_BOT' },
        { Key: 'ManagedBy', Value: 'CDK' },
      ]),
    });
    expect(provider.Properties.Tags).not.toContainEqual(expect.objectContaining({ Key: 'Environment' }));
  });

  // Verifies each environment's exact role identities, trust constraints, sessions, and tags.
  test.each([
    ['DEV', 'dev'],
    ['DEMO', 'demo'],
  ])('uses exact %s role names, principals, subjects, sessions, and tags', (upper, environment) => {
    const { template } = synthesize();
    const deploy = roleByName(template, `SOC_BOT_${upper}_DEPLOY`);
    const execution = roleByName(template, `SOC_BOT_${upper}_CFN_EXEC`);
    const deployTrust = deploy.Properties.AssumeRolePolicyDocument.Statement[0];
    const executionTrust = execution.Properties.AssumeRolePolicyDocument.Statement[0];

    expect(deployTrust.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(deployTrust.Condition.StringEquals).toMatchObject({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': `repo:Alvin-Janton/SOC_BOT:environment:${environment}`,
    });
    expect(executionTrust).toMatchObject({
      Action: 'sts:AssumeRole',
      Principal: { Service: 'cloudformation.amazonaws.com' },
    });
    expect(deploy.Properties.MaxSessionDuration).toBe(3600);
    expect(execution.Properties.MaxSessionDuration).toBe(3600);
    for (const role of [deploy, execution]) {
      expect(role.Properties.Tags).toEqual(expect.arrayContaining([
        { Key: 'Project', Value: 'SOC_BOT' },
        { Key: 'Environment', Value: environment },
        { Key: 'ManagedBy', Value: 'CDK' },
      ]));
    }
  });

  // Verifies stack operations cannot cross environments and only dev can delete stacks.
  test('isolates dev and demo CloudFormation permissions and DeleteStack', () => {
    const { template } = synthesize();
    const dev = roleByName(template, 'SOC_BOT_DEV_DEPLOY').Properties.Policies[0].PolicyDocument.Statement;
    const demo = roleByName(template, 'SOC_BOT_DEMO_DEPLOY').Properties.Policies[0].PolicyDocument.Statement;
    const devStack = dev.find((statement: JsonObject) => statement.Sid === 'ManageDevProjectStacks');
    const demoStack = demo.find((statement: JsonObject) => statement.Sid === 'ManageDemoProjectStacks');

    expect(JSON.stringify(devStack.Resource)).toContain('SOC-BOT-DEV-*');
    expect(JSON.stringify(devStack.Resource)).not.toContain('SOC-BOT-DEMO-*');
    expect(JSON.stringify(demoStack.Resource)).toContain('SOC-BOT-DEMO-*');
    expect(JSON.stringify(demoStack.Resource)).not.toContain('SOC-BOT-DEV-*');
    expect(actions(devStack)).toContain('cloudformation:DeleteStack');
    expect(actions(demoStack)).not.toContain('cloudformation:DeleteStack');
  });

  // Verifies PassRole permissions target only approved execution and runtime role namespaces.
  test('never wildcards PassRole and limits every target namespace', () => {
    const { template } = synthesize();
    const passRole = statements(template)
      .filter((statement) => actions(statement).includes('iam:PassRole'));
    expect(passRole).toHaveLength(4);

    const serialized = passRole.map((statement) => JSON.stringify(statement.Resource));
    expect(serialized.every((resource) => resource !== '"*"')).toBe(true);
    expect(serialized).toEqual(expect.arrayContaining([
      expect.stringContaining('SOC_BOT_DEV_CFN_EXEC'),
      expect.stringContaining('SOC_BOT_DEMO_CFN_EXEC'),
      expect.stringContaining('SOC_BOT_DEV_RUNTIME_APPLICATION_*'),
      expect.stringContaining('SOC_BOT_DEMO_RUNTIME_APPLICATION_*'),
    ]));
  });

  // Verifies each environment can pass only its own execution and runtime roles.
  test.each(['DEV', 'DEMO'])('%s PassRole statements cannot cross environments', (upper) => {
    const { template } = synthesize();
    const other = upper === 'DEV' ? 'DEMO' : 'DEV';
    const deploy = roleByName(template, `SOC_BOT_${upper}_DEPLOY`);
    const runtime = managedPolicyByName(template, `SOC_BOT_${upper}_CFN_RUNTIME_IAM`);
    const deployPassRole = deploy.Properties.Policies[0].PolicyDocument.Statement
      .find((statement: JsonObject) => actions(statement).includes('iam:PassRole'));
    const runtimePassRole = runtime.Properties.PolicyDocument.Statement
      .find((statement: JsonObject) => actions(statement).includes('iam:PassRole'));

    expect(JSON.stringify(deployPassRole.Resource)).toContain(`SOC_BOT_${upper}_CFN_EXEC`);
    expect(JSON.stringify(runtimePassRole.Resource)).toContain(`SOC_BOT_${upper}_RUNTIME_APPLICATION_*`);
    expect(JSON.stringify([deployPassRole.Resource, runtimePassRole.Resource])).not.toContain(
      `SOC_BOT_${other}_`,
    );
  });

  // Verifies each execution role receives the five policies approved for its environment.
  test.each(['DEV', 'DEMO'])('%s execution role has exactly five matching managed policies', (upper) => {
    const { template } = synthesize();
    const role = roleByName(template, `SOC_BOT_${upper}_CFN_EXEC`);
    expect(role.Properties.ManagedPolicyArns).toHaveLength(5);
    for (const reference of role.Properties.ManagedPolicyArns) {
      const logicalId = reference.Ref as string;
      expect(template.Resources[logicalId].Properties.ManagedPolicyName).toMatch(
        new RegExp(`^SOC_BOT_${upper}_CFN_`),
      );
    }
  });

  // Verifies runtime roles cannot be created without the required boundary and ownership tags.
  test.each([
    ['DEV', 'dev'],
    ['DEMO', 'demo'],
  ])('%s runtime role creation requires its boundary and tags', (upper, environment) => {
    const { template } = synthesize();
    const policy = managedPolicyByName(template, `SOC_BOT_${upper}_CFN_RUNTIME_IAM`);
    const createRole = policy.Properties.PolicyDocument.Statement
      .find((statement: JsonObject) => actions(statement).includes('iam:CreateRole'));
    const condition = createRole.Condition;

    expect(JSON.stringify(createRole.Resource)).toContain(`SOC_BOT_${upper}_RUNTIME_APPLICATION_*`);
    expect(JSON.stringify(condition.StringEquals['iam:PermissionsBoundary']))
      .toContain(`SOC_BOT_${upper}_BOUNDARY_APPLICATION`);
    expect(condition.StringEquals).toMatchObject({
      'aws:RequestTag/Project': 'SOC_BOT',
      'aws:RequestTag/Environment': environment,
      'aws:RequestTag/ManagedBy': 'CDK',
    });
    expect(condition['ForAllValues:StringEquals']['aws:TagKeys'])
      .toEqual(expect.arrayContaining(['Project', 'Environment', 'ManagedBy', 'SOCBOTAccessClass']));
  });

  // Verifies the synthesized policies omit prohibited broad and container-publishing access.
  test('contains no ECR, administrative action wildcards, or bootstrap deployment role', () => {
    const { template } = synthesize();
    const allActions = statements(template).flatMap(actions);
    const serialized = JSON.stringify(template);
    expect(allActions).not.toContain('*');
    expect(allActions).not.toContain('iam:*');
    expect(allActions).not.toContain('cloudformation:*');
    expect(allActions.some((action) => action.startsWith('ecr:'))).toBe(false);
    expect(serialized).not.toContain('cdk-hnb659fds-deploy-role');
  });

  // Verifies both runtime boundaries explicitly deny hidden evaluation-data access.
  test.each(['DEV', 'DEMO'])('%s runtime boundary denies evaluation access', (upper) => {
    const { template } = synthesize();
    const boundary = managedPolicyByName(template, `SOC_BOT_${upper}_BOUNDARY_APPLICATION`);
    const deny = statementBySid(
      boundary,
      `Deny${capitalize(upper.toLowerCase())}EvaluationGroundTruth`,
    );
    expect(actions(deny)).toEqual(['s3:*']);
    expect(JSON.stringify(deny.Resource)).toContain('/evaluation');
    expect(JSON.stringify(deny.Resource)).toContain('/evaluation/*');
  });

  // Verifies the obsolete Bedrock parameter is absent and foundation outputs remain present.
  test('has no Bedrock parameter and retains five role/provider outputs', () => {
    const { template } = synthesize();
    expect(template.Parameters?.ApprovedBedrockModelArn).toBeUndefined();
    expect(Object.keys(template.Outputs)).toEqual(expect.arrayContaining([
      'GitHubOidcProviderArn',
      'DevDeployRoleArn',
      'DemoDeployRoleArn',
      'DevCloudFormationExecutionRoleArn',
      'DemoCloudFormationExecutionRoleArn',
    ]));
  });

  // Verifies frontend creation and lifecycle statements enforce ownership tags without fail-open conditions.
  test.each([
    ['DEV', 'dev'],
    ['DEMO', 'demo'],
  ])('%s frontend policy strictly isolates tagged resources', (upper, environment) => {
    const { template } = synthesize();
    const policy = managedPolicyByName(template, `SOC_BOT_${upper}_CFN_FRONTEND_API`);
    const serialized = JSON.stringify(policy);
    const createSids = [
      `CreateTagged${capitalize(environment)}ApiGateway`,
      `CreateTagged${capitalize(environment)}CognitoUserPool`,
      `CreateTagged${capitalize(environment)}CloudFrontDistribution`,
    ];

    expect(serialized).not.toContain('StringEqualsIfExists');
    expect(serialized).not.toContain('UntagResource');
    for (const sid of createSids) {
      const create = statementBySid(policy, sid);
      expect(create.Condition.StringEquals).toMatchObject({
        'aws:RequestTag/Project': 'SOC_BOT',
        'aws:RequestTag/Environment': environment,
        'aws:RequestTag/ManagedBy': 'CDK',
      });
      expect(create.Condition['ForAllValues:StringEquals']['aws:TagKeys'])
        .toEqual(['Project', 'Environment', 'ManagedBy']);
    }

    for (const sid of [
      `ManageTagged${capitalize(environment)}ApiGateway`,
      `ManageTagged${capitalize(environment)}CognitoUserPools`,
      `ManageTagged${capitalize(environment)}CloudFrontDistributions`,
    ]) {
      expect(statementBySid(policy, sid).Condition.StringEquals).toMatchObject({
        'aws:ResourceTag/Project': 'SOC_BOT',
        'aws:ResourceTag/Environment': environment,
        'aws:ResourceTag/ManagedBy': 'CDK',
      });
    }

    const createDistribution = statementBySid(
      policy,
      `CreateTagged${capitalize(environment)}CloudFrontDistribution`,
    );
    const manageDistribution = statementBySid(
      policy,
      `ManageTagged${capitalize(environment)}CloudFrontDistributions`,
    );
    expect(createDistribution.Resource).toBe('*');
    expect(JSON.stringify(manageDistribution.Resource)).toContain(':distribution/*');
  });

  // Verifies runtime S3 listing is limited to role-specific prefixes and evaluation remains inaccessible.
  test.each([
    ['DEV', 'dev'],
    ['DEMO', 'demo'],
  ])('%s runtime boundary restricts bucket listing to approved prefixes', (upper, environment) => {
    const { template } = synthesize();
    const boundary = managedPolicyByName(template, `SOC_BOT_${upper}_BOUNDARY_APPLICATION`);
    const title = capitalize(environment);
    const queryBoundary = managedPolicyByName(template, `SOC_BOT_${upper}_BOUNDARY_QUERY`);
    const glueBoundary = managedPolicyByName(template, `SOC_BOT_${upper}_BOUNDARY_GLUE`);
    const queryList = statementBySid(queryBoundary, `Allow${title}AthenaResultListing`);
    const glueList = statementBySid(glueBoundary, `Allow${title}GluePrefixListing`);

    expect(queryList.Condition.StringLike['s3:prefix']).toEqual([
      'athena-results', 'athena-results/*',
    ]);
    expect(glueList.Condition.StringLike['s3:prefix']).toEqual([
      'raw', 'raw/*', 'normalized', 'normalized/*', 'quarantine', 'quarantine/*',
    ]);
    expect(JSON.stringify(queryList.Condition)).not.toContain('evaluation');
    expect(JSON.stringify(glueList.Condition)).not.toContain('evaluation');

    const listStatements = [...queryBoundary.Properties.PolicyDocument.Statement, ...glueBoundary.Properties.PolicyDocument.Statement]
      .filter((statement: JsonObject) => actions(statement).includes('s3:ListBucket'));
    expect(listStatements).toHaveLength(2);

    const evaluationDeny = statementBySid(boundary, `Deny${title}EvaluationGroundTruth`);
    expect(actions(evaluationDeny)).toEqual(['s3:*']);
  });

  // Verifies corrected S3, Logs, and Budgets action/resource compatibility.
  test.each([
    ['DEV', 'dev'],
    ['DEMO', 'demo'],
  ])('%s execution policies contain corrected service permissions', (upper, environment) => {
    const { template } = synthesize();
    const title = capitalize(environment);
    const data = managedPolicyByName(template, `SOC_BOT_${upper}_CFN_DATA_ANALYTICS`);
    const observability = managedPolicyByName(template, `SOC_BOT_${upper}_CFN_OBSERVABILITY`);
    const bucket = statementBySid(data, `Manage${title}DataBuckets`);
    const describeLogs = statementBySid(observability, `Describe${title}LogGroups`);
    const budget = statementBySid(observability, `Manage${title}Budget`);

    expect(actions(bucket)).toContain('s3:DeleteBucketPolicy');
    expect(actions(describeLogs)).toEqual(['logs:DescribeLogGroups']);
    expect(describeLogs.Resource).toBe('*');
    expect(actions(budget)).toEqual(expect.arrayContaining([
      'budgets:ModifyBudget', 'budgets:ViewBudget', 'budgets:TagResource',
    ]));
    expect(actions(budget).some((action) => action.includes('BudgetAction'))).toBe(false);
  });

  // Verifies profile invocation is pinned to the selected profile and its routed model only.
  test.each(['DEV', 'DEMO'])('%s Bedrock access requires the selected inference profile', (upper) => {
    const { template } = synthesize();
    const boundary = managedPolicyByName(template, `SOC_BOT_${upper}_BOUNDARY_APPLICATION`);
    const title = capitalize(upper.toLowerCase());
    const profile = statementBySid(boundary, `Allow${title}ApprovedBedrockInferenceProfile`);
    const model = statementBySid(boundary, `Allow${title}ApprovedBedrockProfileModels`);
    const profileArn = JSON.stringify(profile.Resource);

    expect(profileArn).toContain(`:inference-profile/${BEDROCK_INFERENCE_PROFILE.profileId}`);
    expect(JSON.stringify(model.Resource)).toContain(
      `:bedrock:*::foundation-model/${BEDROCK_INFERENCE_PROFILE.foundationModelId}`,
    );
    expect(JSON.stringify(model.Condition.StringEquals['bedrock:InferenceProfileArn']))
      .toContain(`:inference-profile/${BEDROCK_INFERENCE_PROFILE.profileId}`);
  });

  test('has six independent boundaries and exact Lake Formation administration', () => {
    const { template } = synthesize();
    const boundaries = resourcesOfType(template, 'AWS::IAM::ManagedPolicy')
      .filter((p) => p.Properties.ManagedPolicyName.includes('_BOUNDARY_'));
    expect(boundaries).toHaveLength(6);
    for (const upper of ['DEV', 'DEMO']) {
      for (const kind of ['APPLICATION', 'QUERY', 'GLUE']) {
        const p = managedPolicyByName(template, `SOC_BOT_${upper}_BOUNDARY_${kind}`);
        expect(JSON.stringify(p)).not.toContain('aws:PrincipalTag/');
        const allowed = p.Properties.PolicyDocument.Statement.filter((s: JsonObject) => s.Effect === 'Allow').flatMap(actions);
        if (kind !== 'APPLICATION') expect(allowed.some((a: string) => /^(bedrock|dynamodb|cognito-idp|lambda):/.test(a))).toBe(false);
        if (kind !== 'QUERY') expect(allowed.some((a: string) => /^(athena|lakeformation):/.test(a))).toBe(false);
        if (kind !== 'GLUE') expect(allowed).not.toContain('glue:UpdateTable');
        if (kind === 'APPLICATION') {
          const cognito = p.Properties.PolicyDocument.Statement.find((s: JsonObject) => actions(s).includes('cognito-idp:AdminInitiateAuth'));
          expect(cognito.Condition.StringEquals).toEqual({
            'aws:ResourceTag/Project': 'SOC_BOT', 'aws:ResourceTag/Environment': upper.toLowerCase(),
            'aws:ResourceTag/ManagedBy': 'CDK',
          });
          expect(allowed).not.toContain('s3:ListBucket');
        }
        expect(p.Properties.PolicyDocument.Statement.some((s: JsonObject) => s.Effect === 'Deny' && actions(s).includes('s3:*'))).toBe(true);
      }
      const data = managedPolicyByName(template, `SOC_BOT_${upper}_CFN_DATA_ANALYTICS`);
      const lf = data.Properties.PolicyDocument.Statement.filter((s: JsonObject) => actions(s).some((a) => a.startsWith('lakeformation:')));
      expect(lf).toHaveLength(1);
      expect(lf[0].Resource).toBe('*');
      expect(actions(lf[0]).sort()).toEqual(['lakeformation:DeregisterResource', 'lakeformation:GrantPermissions',
        'lakeformation:ListPermissions', 'lakeformation:RegisterResource', 'lakeformation:RevokePermissions']);
    }
  });

  test.each(['DEV', 'DEMO'])('%s enforces class mappings and protects boundary policies and tags', (upper) => {
    const { template } = synthesize();
    const policy = managedPolicyByName(template, `SOC_BOT_${upper}_CFN_RUNTIME_IAM`);
    const ss: JsonObject[] = policy.Properties.PolicyDocument.Statement;
    for (const kind of ['APPLICATION', 'QUERY', 'GLUE']) {
      for (const action of ['iam:CreateRole', 'iam:PutRolePermissionsBoundary']) {
        const matches = ss.filter((s) => actions(s).includes(action) && JSON.stringify(s.Resource).includes(`RUNTIME_${kind}_*`));
        expect(matches).toHaveLength(1);
        expect(JSON.stringify(matches[0].Condition.StringEquals['iam:PermissionsBoundary'])).toContain(`SOC_BOT_${upper}_BOUNDARY_${kind}`);
        const tagType = action === 'iam:CreateRole' ? 'RequestTag' : 'ResourceTag';
        expect(matches[0].Condition.StringEquals[`aws:${tagType}/SOCBOTAccessClass`]).toBe(kind.toLowerCase());
        expect(matches[0].Condition.StringEquals[`aws:${tagType}/Environment`]).toBe(upper.toLowerCase());
      }
    }
    const attachments = ss.find((s) => actions(s).includes('iam:AttachRolePolicy'))!;
    expect(JSON.stringify(attachments.Resource)).not.toContain(':policy/');
    expect(JSON.stringify(attachments.Condition.ArnLike['iam:PolicyARN'])).toContain(`SOC_BOT_${upper}_RUNTIME_POLICY_*`);
    expect(JSON.stringify(attachments.Condition)).not.toContain('_BOUNDARY_');
    const removal = ss.find((s) => s.Effect === 'Allow' && actions(s).includes('iam:DeleteRolePermissionsBoundary'))!;
    expect(removal.Resource).toHaveLength(3);
    for (const resource of removal.Resource) expect(JSON.stringify(resource)).toMatch(/RUNTIME_(APPLICATION|QUERY|GLUE)_/);
    const deny = ss.find((s) => s.Effect === 'Deny' && actions(s).includes('iam:DeletePolicy'))!;
    expect(JSON.stringify(deny.Resource)).toContain(`SOC_BOT_${upper}_BOUNDARY_*`);
    expect(actions(deny).sort()).toEqual(['iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:TagPolicy', 'iam:UntagPolicy']);
    const tagDenies = ss.filter((s) => s.Effect === 'Deny' && actions(s).includes('iam:TagRole'));
    expect(tagDenies).toHaveLength(4);
    for (const key of ['Project', 'Environment', 'ManagedBy', 'SOCBOTAccessClass']) {
      const tagDeny = tagDenies.find((s) => s.Condition.Null[`aws:ResourceTag/${key}`] === 'false')!;
      expect(tagDeny).toBeDefined();
      expect(tagDeny.Condition.StringNotEquals[`aws:ResourceTag/${key}`]).toBe('${aws:RequestTag/' + key + '}');
    }
    expect(ss.some((s) => s.Effect === 'Deny' && actions(s).includes('iam:UntagRole'))).toBe(true);
  });

  // Verifies the committed CDK source resolves drafts through tokens rather than local values.
  test('contains no literal project account or draft placeholders', () => {
    const { template } = synthesize();
    const serialized = JSON.stringify(template);
    expect(serialized).not.toContain('522814735684');
    expect(serialized).not.toMatch(/\$\{(?:AWS_|FRONTEND_|DATA_|BEDROCK_)/);
  });
});

/** Uppercases the first character for synthesized statement identifiers. */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
