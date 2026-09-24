import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CicdFoundationStack } from '../lib/cicd-foundation-stack';

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
      expect.stringContaining('SOC_BOT_DEV_RUNTIME_*'),
      expect.stringContaining('SOC_BOT_DEMO_RUNTIME_*'),
    ]));
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

    expect(JSON.stringify(createRole.Resource)).toContain(`SOC_BOT_${upper}_RUNTIME_*`);
    expect(JSON.stringify(condition.StringEquals['iam:PermissionsBoundary']))
      .toContain(`SOC_BOT_${upper}_RUNTIME_BOUNDARY`);
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
    const boundary = managedPolicyByName(template, `SOC_BOT_${upper}_RUNTIME_BOUNDARY`);
    const deny = boundary.Properties.PolicyDocument.Statement
      .find((statement: JsonObject) => statement.Effect === 'Deny');
    expect(actions(deny)).toEqual(['s3:*']);
    expect(JSON.stringify(deny.Resource)).toContain('/evaluation');
    expect(JSON.stringify(deny.Resource)).toContain('/evaluation/*');
  });

  // Verifies deployment inputs and externally consumed role/provider outputs remain present.
  test('has the required parameter and five role/provider outputs', () => {
    const { template } = synthesize();
    expect(template.Parameters.ApprovedBedrockModelArn).toBeDefined();
    expect(template.Parameters.ApprovedBedrockModelArn.Default).toBeUndefined();
    expect(Object.keys(template.Outputs)).toEqual(expect.arrayContaining([
      'GitHubOidcProviderArn',
      'DevDeployRoleArn',
      'DemoDeployRoleArn',
      'DevCloudFormationExecutionRoleArn',
      'DemoCloudFormationExecutionRoleArn',
    ]));
  });

  // Verifies the committed CDK source resolves drafts through tokens rather than local values.
  test('contains no literal project account or draft placeholders', () => {
    const { template } = synthesize();
    const serialized = JSON.stringify(template);
    expect(serialized).not.toContain('522814735684');
    expect(serialized).not.toMatch(/\$\{(?:AWS_|FRONTEND_|DATA_|BEDROCK_)/);
  });
});
