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
