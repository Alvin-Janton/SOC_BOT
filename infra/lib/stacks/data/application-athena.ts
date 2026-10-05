import { RemovalPolicy } from 'aws-cdk-lib';
import { CfnWorkGroup } from 'aws-cdk-lib/aws-athena';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DeploymentEnvironment } from '../../shared/environment';

export interface ApplicationAthenaProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly dataBucket: Bucket;
}

/** Defines the environment's Athena workgroup with enforced result and scan controls. */
export class ApplicationAthena extends Construct {
  public constructor(scope: Construct, id: string, props: ApplicationAthenaProps) {
    super(scope, id);
    const { deploymentEnvironment: environment, dataBucket } = props;

    const workgroup = new CfnWorkGroup(this, 'Workgroup', {
      name: `SOC-BOT-${environment.toUpperCase()}-QUERY`,
      description: `SOC Bot ${environment} queries over normalized security evidence`,
      state: 'ENABLED',
      recursiveDeleteOption: environment === 'dev',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        bytesScannedCutoffPerQuery: 128 * 1024 * 1024,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${dataBucket.bucketName}/athena-results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });
    workgroup.applyRemovalPolicy(environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN);
  }
}
