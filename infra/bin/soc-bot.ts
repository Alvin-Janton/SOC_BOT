#!/usr/bin/env node
import { App, CliCredentialsStackSynthesizer, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CicdFoundationStack } from '../lib/stacks/cicd-foundation/cicd-foundation-stack';
import { DataStack } from '../lib/stacks/data/data-stack';
import { AiStack } from '../lib/stacks/ai/ai-stack';
import { DEFAULT_QUERY_WINDOW_DAYS, queryWindowDays } from '../lib/stacks/ai/query-contract';
import { devClientCidr } from '../lib/stacks/ai/chat-api';
import { FrontendStack } from '../lib/stacks/frontend/frontend-stack';

const app = new App();
const devAllowedClientCidr = devClientCidr(app.node.tryGetContext('devAllowedClientCidr')).cidr;

const foundation = new CicdFoundationStack(app, 'CicdFoundationStack', {
  stackName: 'SOC-BOT-CICD-FOUNDATION',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Account-level GitHub OIDC and CI/CD IAM foundation for SOC Bot',
});

for (const environment of ['dev', 'demo'] as const) {
  const dataStack = new DataStack(app, `${environment}DataStack`, {
    deploymentEnvironment: environment,
    stackName: `SOC-BOT-${environment.toUpperCase()}-DATA`,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
    synthesizer: new CliCredentialsStackSynthesizer({
      fileAssetsBucketName: `soc-bot-${environment}-glue-files-\${AWS::AccountId}-\${AWS::Region}`,
      bucketPrefix: 'glue/',
    }),
    description: `SOC Bot ${environment} security data, Glue normalization, and Athena workgroup`,
  });
  const aiStack = new AiStack(app, `${environment}AiStack`, {
    deploymentEnvironment: environment,
    stackName: `SOC-BOT-${environment.toUpperCase()}-AI`,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
    // Publish bundles with caller credentials; never assume the administrator bootstrap role.
    synthesizer: new CliCredentialsStackSynthesizer(),
    dataBucket: dataStack.dataBucket,
    database: dataStack.database,
    tables: dataStack.tables,
    workgroup: dataStack.workgroup,
    maxQueryWindowDays: queryWindowDays(Number(app.node.tryGetContext('queryMaxTimeSpanDays') ?? DEFAULT_QUERY_WINDOW_DAYS)),
    devAllowedClientCidr: environment === 'dev' ? devAllowedClientCidr : undefined,
    description: `SOC Bot ${environment} read-only investigation tools and streaming chat API`,
  });
  // The Regional logging account setting is administrator-managed, never recreated by AI.
  aiStack.addStackDependency(foundation);
  const frontendStack = new FrontendStack(app, `${environment}FrontendStack`, {
    deploymentEnvironment: environment, stackName: `SOC-BOT-${environment.toUpperCase()}-FRONTEND`,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
    synthesizer: new CliCredentialsStackSynthesizer(),
    description: `SOC Bot ${environment} private frontend, health API and inactive authentication foundation`,
  });
  frontendStack.addStackDependency(foundation);
}

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

app.synth();
