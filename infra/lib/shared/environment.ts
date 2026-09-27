import { Aws } from 'aws-cdk-lib';

export type DeploymentEnvironment = 'dev' | 'demo';

/** Returns the data bucket name used by application stacks and foundation IAM policies. */
export function dataBucketName(environment: DeploymentEnvironment): string {
  return `soc-bot-${environment}-data-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
}
