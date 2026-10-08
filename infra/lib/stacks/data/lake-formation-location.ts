import { CfnResource } from 'aws-cdk-lib/aws-lakeformation';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface LakeFormationLocationProps {
  readonly dataBucket: IBucket;
}

/** Registers only normalized evidence; the existing service-linked role supplies Athena data access. */
export class LakeFormationLocation extends Construct {
  public readonly location: CfnResource;

  public constructor(scope: Construct, id: string, props: LakeFormationLocationProps) {
    super(scope, id);
    this.location = new CfnResource(this, 'NormalizedLocation', {
      resourceArn: props.dataBucket.arnForObjects('normalized/'),
      useServiceLinkedRole: true,
      hybridAccessEnabled: false,
    });
  }
}
