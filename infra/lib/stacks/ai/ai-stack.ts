import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { CfnWorkGroup } from 'aws-cdk-lib/aws-athena';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DeploymentEnvironment } from '../../shared/environment';
import { AthenaQueryTool } from './athena-query-tool';

export interface AiStackProps extends StackProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly dataBucket: IBucket;
  readonly workgroup: CfnWorkGroup;
  readonly database: CfnDatabase;
  readonly tables: readonly CfnTable[];
  readonly maxQueryWindowDays?: number;
}

/** Starts the environment AI stack with its private query tool; orchestration remains deferred. */
export class AiStack extends Stack {
  public readonly queryTool: AthenaQueryTool;

  public constructor(scope: Construct, id: string, props: AiStackProps) {
    super(scope, id, props);
    this.queryTool = new AthenaQueryTool(this, 'AthenaQueryTool', props);
    Tags.of(this).add('Project', 'SOC_BOT');
    Tags.of(this).add('Environment', props.deploymentEnvironment);
    Tags.of(this).add('ManagedBy', 'CDK');
  }
}
