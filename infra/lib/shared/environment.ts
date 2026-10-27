import { Aws } from 'aws-cdk-lib';

export type DeploymentEnvironment = 'dev' | 'demo';

/** Returns the data bucket name used by application stacks and foundation IAM policies. */
export function dataBucketName(environment: DeploymentEnvironment): string {
  return `soc-bot-${environment}-data-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
}

/** Names the pre-created, environment-specific bucket used for CDK file assets. */
export function glueFileBucketName(environment: DeploymentEnvironment): string {
  return `soc-bot-${environment}-glue-files-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
}

/** Names the CDK-managed access log group shared by the API and foundation logging policy. */
export function chatApiAccessLogGroupName(environment: DeploymentEnvironment): string {
  return `/aws/apigateway/SOC-BOT-${environment.toUpperCase()}-CHAT-ACCESS`;
}

/** Names the independent frontend API access log group shared with foundation logging grants. */
export function frontendApiAccessLogGroupName(environment: DeploymentEnvironment): string {
  return `/aws/apigateway/SOC-BOT-${environment.toUpperCase()}-FRONTEND-ACCESS`;
}

/** Keeps private hosting bucket names aligned with foundation upload/deployment permissions. */
export function frontendBucketName(environment: DeploymentEnvironment): string {
  return `soc-bot-${environment}-frontend-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
}
