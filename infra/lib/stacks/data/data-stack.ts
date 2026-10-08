import { Duration, RemovalPolicy, Stack, StackProps, Tags, Validations } from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket, BucketEncryption, CfnBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CfnWorkGroup } from 'aws-cdk-lib/aws-athena';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { dataBucketName, DeploymentEnvironment } from '../../shared/environment';
import { ApplicationAthena } from './application-athena';
import { ApplicationGlue } from './application-glue';

export interface DataStackProps extends StackProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
}

/** Owns the private data bucket, Glue normalization, and Athena workgroup for one environment. */
export class DataStack extends Stack {
  public readonly dataBucket: Bucket;
  public readonly database: CfnDatabase;
  public readonly tables: CfnTable[];
  public readonly workgroup: CfnWorkGroup;

  public constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { deploymentEnvironment } = props;
    const bucket = new Bucket(this, 'DataBucket', {
      bucketName: dataBucketName(deploymentEnvironment),
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [{
        id: 'ExpireAthenaResultsAfterSevenDays',
        enabled: true,
        prefix: 'athena-results/',
        expiration: Duration.days(7),
      }],
      removalPolicy: deploymentEnvironment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    Validations.of(bucket.node.defaultChild as CfnBucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'This protected data bucket stores raw and normalized security evidence. Access-log storage and retention will be reviewed with the data lifecycle design.',
    });

    const glue = new ApplicationGlue(this, 'ApplicationGlue', { deploymentEnvironment, dataBucket: bucket });
    const athena = new ApplicationAthena(this, 'ApplicationAthena', { deploymentEnvironment, dataBucket: bucket });
    this.dataBucket = bucket;
    this.database = glue.database;
    this.tables = glue.tables;
    this.workgroup = athena.workgroup;

    Tags.of(this).add('Project', 'SOC_BOT');
    Tags.of(this).add('Environment', deploymentEnvironment);
    Tags.of(this).add('ManagedBy', 'CDK');
  }
}
