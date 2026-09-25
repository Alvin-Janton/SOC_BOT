import {
  CfnOutput,
  Duration,
  Stack,
  StackProps,
  Tags,
  Validations,
} from 'aws-cdk-lib';
import {
  CfnManagedPolicy,
  CfnOIDCProvider,
  CfnRole,
  ManagedPolicy,
  PolicyDocument,
  Role,
  ServicePrincipal,
  WebIdentityPrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  aiApplicationStatements,
  dataAndAnalyticsStatements,
  deploymentStatements,
  DeploymentEnvironment,
  environmentResources,
  frontendApiStatements,
  observabilityStatements,
  runtimeBoundaryStatements,
  RUNTIME_CLASSES,
  runtimeIamStatements,
} from './policy-statements';

interface EnvironmentFoundation {
  readonly deployRole: Role;
  readonly executionRole: Role;
}

export class CicdFoundationStack extends Stack {
  /** Defines the shared GitHub OIDC provider and isolated dev/demo IAM foundations. */
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const oidcProvider = new CfnOIDCProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdList: ['sts.amazonaws.com'],
      tags: [
        { key: 'Project', value: 'SOC_BOT' },
        { key: 'ManagedBy', value: 'CDK' },
      ],
    });

    const dev = this.createEnvironmentFoundation('dev', oidcProvider);
    const demo = this.createEnvironmentFoundation('demo', oidcProvider);

    new CfnOutput(this, 'GitHubOidcProviderArn', {
      value: oidcProvider.attrArn,
    });
    new CfnOutput(this, 'DevDeployRoleArn', { value: dev.deployRole.roleArn });
    new CfnOutput(this, 'DemoDeployRoleArn', { value: demo.deployRole.roleArn });
    new CfnOutput(this, 'DevCloudFormationExecutionRoleArn', { value: dev.executionRole.roleArn });
    new CfnOutput(this, 'DemoCloudFormationExecutionRoleArn', { value: demo.executionRole.roleArn });
  }

  /** Creates the deployment role, execution role, policies, and boundary for one environment. */
  private createEnvironmentFoundation(
    environment: DeploymentEnvironment,
    oidcProvider: CfnOIDCProvider,
  ): EnvironmentFoundation {
    const upper = environment.toUpperCase();
    const title = environment.charAt(0).toUpperCase() + environment.slice(1);
    const resources = environmentResources(environment);
    const tags = {
      Project: 'SOC_BOT',
      Environment: environment,
      ManagedBy: 'CDK',
    };

    for (const kind of RUNTIME_CLASSES) {
      const boundary = this.createManagedPolicy(
        `${title}Boundary${kind.charAt(0).toUpperCase() + kind.slice(1)}`,
        `SOC_BOT_${upper}_BOUNDARY_${kind.toUpperCase()}`,
        runtimeBoundaryStatements(resources, kind),
        this.iamWildcardFindings('boundary', environment),
        'Class-specific runtime limits use environment resources, scoped listing, and evaluation denial. Bedrock Region wildcard is restricted to the approved model through the exact US profile.',
      );
      boundary.node.addMetadata('Purpose', `${environment} ${kind} runtime boundary`);
    }

    const dataPolicy = this.createManagedPolicy(
      `${title}DataAnalyticsPolicy`,
      `SOC_BOT_${upper}_CFN_DATA_ANALYTICS`,
      dataAndAnalyticsStatements(resources),
      this.iamWildcardFindings('data', environment),
      'Data resources are limited to the environment namespace; Lake Formation registration and grant APIs require account-scoped resources.',
    );
    const aiPolicy = this.createManagedPolicy(
      `${title}AiApplicationPolicy`,
      `SOC_BOT_${upper}_CFN_AI_APPLICATION`,
      aiApplicationStatements(resources),
      this.iamWildcardFindings('ai', environment),
      'Application resources use the environment prefix; the shared bootstrap file bucket is restricted to read-only asset retrieval.',
    );
    const frontendPolicy = this.createManagedPolicy(
      `${title}FrontendApiPolicy`,
      `SOC_BOT_${upper}_CFN_FRONTEND_API`,
      frontendApiStatements(resources),
      this.iamWildcardFindings('frontend', environment),
      'Frontend resources use environment tags and prefixes; Cognito creation and CloudFront origin access control APIs require account-scoped resources.',
    );
    const observabilityPolicy = this.createManagedPolicy(
      `${title}ObservabilityPolicy`,
      `SOC_BOT_${upper}_CFN_OBSERVABILITY`,
      observabilityStatements(resources),
      this.iamWildcardFindings('observability', environment),
      'Observability resources use environment-qualified names; DescribeLogGroups requires account-wide Resource "*".',
    );
    const runtimeIamPolicy = this.createManagedPolicy(
      `${title}RuntimeIamPolicy`,
      `SOC_BOT_${upper}_CFN_RUNTIME_IAM`,
      runtimeIamStatements(resources),
      this.iamWildcardFindings('runtime-iam', environment),
      'Runtime IAM access is restricted to the environment runtime namespace and requires the matching permission boundary and tags.',
    );
    const managedPolicies = [dataPolicy, aiPolicy, frontendPolicy, observabilityPolicy, runtimeIamPolicy];

    const executionRole = new Role(this, `${title}CloudFormationExecutionRole`, {
      roleName: `SOC_BOT_${upper}_CFN_EXEC`,
      description: `CloudFormation execution role for SOC Bot ${environment} stacks`,
      assumedBy: new ServicePrincipal('cloudformation.amazonaws.com'),
      maxSessionDuration: Duration.hours(1),
      managedPolicies,
    });
    this.applyTags(executionRole, tags);

    const subject = `repo:Alvin-Janton/SOC_BOT:environment:${environment}`;
    const deployRole = new Role(this, `${title}DeployRole`, {
      roleName: `SOC_BOT_${upper}_DEPLOY`,
      description: `GitHub Actions deployment role for the SOC Bot ${environment} environment`,
      assumedBy: new WebIdentityPrincipal(oidcProvider.attrArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subject,
        },
      }),
      inlinePolicies: {
        [`SOC_BOT_${upper}_DEPLOY_INLINE`]: new PolicyDocument({
          statements: deploymentStatements(resources),
        }),
      },
      maxSessionDuration: Duration.hours(1),
    });
    this.applyTags(deployRole, tags);
    const deployRoleResource = deployRole.node.defaultChild;
    if (!(deployRoleResource instanceof CfnRole)) {
      throw new Error(`Expected ${title}DeployRole to synthesize as AWS::IAM::Role`);
    }
    this.acknowledgeIamWildcards(
      deployRoleResource,
      this.iamWildcardFindings('deploy', environment),
      'Deployment wildcards are limited to the matching application stack prefix, deterministic file-asset/frontend buckets, and tagged CloudFront distributions.',
    );


    return { deployRole, executionRole };
  }

  /** Creates a named managed policy and records its reviewed cdk-nag wildcard findings. */
  private createManagedPolicy(
    id: string,
    managedPolicyName: string,
    statements: import('aws-cdk-lib/aws-iam').PolicyStatement[],
    iamWildcardFindings: string[],
    iamWildcardRationale: string,
  ): ManagedPolicy {
    const policy = new ManagedPolicy(this, id, {
      managedPolicyName,
      document: new PolicyDocument({ statements }),
    });
    const resource = policy.node.defaultChild;
    if (!(resource instanceof CfnManagedPolicy)) {
      throw new Error(`Expected ${id} to synthesize as AWS::IAM::ManagedPolicy`);
    }
    this.acknowledgeIamWildcards(resource, iamWildcardFindings, iamWildcardRationale);

    return policy;
  }

  /** Applies the supplied ownership and environment tags to a taggable CDK construct. */
  private applyTags(resource: Construct, tags: Record<string, string>): void {
    for (const [key, value] of Object.entries(tags)) {
      Tags.of(resource).add(key, value);
    }
  }

  /** Acknowledges specific reviewed AwsSolutions-IAM5 findings on one synthesized resource. */
  private acknowledgeIamWildcards(
    resource: Construct,
    findingIds: string[],
    reason: string,
  ): void {
    for (const findingId of findingIds) {
      Validations.of(resource).acknowledge({
        id: `AwsSolutions-IAM5[${findingId}]`,
        reason,
      });
    }
  }

  /** Returns the exact cdk-nag wildcard finding identifiers expected for a policy category. */
  private iamWildcardFindings(
    policy: 'deploy' | 'boundary' | 'data' | 'ai' | 'frontend' | 'observability' | 'runtime-iam',
    environment: DeploymentEnvironment,
  ): string[] {
    const upper = environment.toUpperCase();
    const account = '<AWS::AccountId>';
    const region = '<AWS::Region>';
    const partition = '<AWS::Partition>';
    // Formats a resource ARN exactly as cdk-nag reports it in an IAM5 finding identifier.
    const resource = (arn: string) => `Resource::${arn}`;

    const findings: Record<typeof policy, string[]> = {
      deploy: [
        resource(`arn:${partition}:cloudformation:${region}:${account}:stack/SOC-BOT-${upper}-*/*`),
        resource(`arn:${partition}:s3:::cdk-hnb659fds-assets-${account}-${region}/*`),
        resource(`arn:${partition}:s3:::soc-bot-${environment}-frontend-${account}-${region}/*`),
        resource(`arn:${partition}:cloudfront::${account}:distribution/*`),
      ],
      boundary: [
        resource(`arn:${partition}:logs:${region}:${account}:log-group:*SOC-BOT-${upper}-*:*`),
        'Resource::*',
        resource(`arn:${partition}:dynamodb:${region}:${account}:table/SOC-BOT-${upper}-*`),
        resource(`arn:${partition}:lambda:${region}:${account}:function:SOC-BOT-${upper}-*`),
        resource(`arn:${partition}:s3:::soc-bot-${environment}-data-${account}-${region}/playbooks/*`),
        resource(`arn:${partition}:cognito-idp:${region}:${account}:userpool/*`),
        resource(`arn:${partition}:athena:${region}:${account}:workgroup/SOC-BOT-${upper}-*`),
        resource(`arn:${partition}:glue:${region}:${account}:database/soc_bot_${environment}*`),
        resource(`arn:${partition}:glue:${region}:${account}:table/soc_bot_${environment}*/*`),
        resource(`arn:${partition}:s3:::soc-bot-${environment}-data-${account}-${region}/athena-results/*`),
        resource(`arn:${partition}:s3:::soc-bot-${environment}-data-${account}-${region}/normalized/*`),
        resource(`arn:${partition}:s3:::soc-bot-${environment}-data-${account}-${region}/quarantine/*`),
        resource(`arn:${partition}:s3:::soc-bot-${environment}-data-${account}-${region}/raw/*`),
        resource(`arn:${partition}:s3:::soc-bot-${environment}-data-${account}-${region}/evaluation/*`),
        resource(`arn:${partition}:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`),
        'Action::s3:*',
      ],
      data: [
        resource(`arn:${partition}:s3:::soc-bot-${environment}-*`),
        resource(`arn:${partition}:s3:::soc-bot-${environment}-*/*`),
        resource(`arn:${partition}:glue:${region}:${account}:database/soc_bot_${environment}*`),
        resource(`arn:${partition}:glue:${region}:${account}:table/soc_bot_${environment}*/*`),
        resource(`arn:${partition}:glue:${region}:${account}:job/SOC-BOT-${upper}-*`),
        resource(`arn:${partition}:glue:${region}:${account}:trigger/SOC-BOT-${upper}-*`),
        resource(`arn:${partition}:athena:${region}:${account}:workgroup/SOC-BOT-${upper}-*`),
        'Resource::*',
      ],
      ai: [
        resource(`arn:${partition}:lambda:${region}:${account}:function:SOC-BOT-${upper}-*`),
        resource(`arn:${partition}:dynamodb:${region}:${account}:table/SOC-BOT-${upper}-*`),
        resource(`arn:${partition}:s3:::cdk-hnb659fds-assets-${account}-${region}/*`),
        resource(`arn:${partition}:events:${region}:${account}:rule/SOC-BOT-${upper}-*`),
      ],
      frontend: [
        resource(`arn:${partition}:apigateway:${region}::/restapis/*`),
        resource(`arn:${partition}:apigateway:${region}::/tags/*`),
        resource(`arn:${partition}:cognito-idp:${region}:${account}:userpool/*`),
        resource(`arn:${partition}:cloudfront::${account}:distribution/*`),
        'Resource::*',
      ],
      observability: [
        resource(`arn:${partition}:logs:${region}:${account}:log-group:*SOC-BOT-${upper}-*`),
        resource(`arn:${partition}:cloudwatch:${region}:${account}:alarm:SOC-BOT-${upper}-*`),
        resource(`arn:${partition}:budgets::${account}:budget/SOC-BOT-${upper}-*`),
        'Resource::*',
      ],
      'runtime-iam': [
        ...RUNTIME_CLASSES.map((kind) => resource(`arn:${partition}:iam::${account}:role/SOC_BOT_${upper}_RUNTIME_${kind.toUpperCase()}_*`)),
        resource(`arn:${partition}:iam::${account}:policy/SOC_BOT_${upper}_RUNTIME_POLICY_*`),
        resource(`arn:${partition}:iam::${account}:policy/SOC_BOT_${upper}_BOUNDARY_*`),
      ],
    };

    return findings[policy];
  }
}
