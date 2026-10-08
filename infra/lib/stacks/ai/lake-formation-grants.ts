import { Aws } from 'aws-cdk-lib';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { CfnPrincipalPermissions } from 'aws-cdk-lib/aws-lakeformation';
import { Construct } from 'constructs';

export interface LakeFormationGrantsProps {
  readonly database: CfnDatabase;
  readonly tables: readonly CfnTable[];
  readonly queryRoleArn: string;
}

/** Owns the dedicated query role's read-only grants, with one resource per principal/resource pair. */
export class LakeFormationGrants extends Construct {
  public constructor(scope: Construct, id: string, props: LakeFormationGrantsProps) {
    super(scope, id);
    const principal = { dataLakePrincipalIdentifier: props.queryRoleArn };
    const databaseGrant = new CfnPrincipalPermissions(this, 'DatabaseDescribe', {
      principal,
      resource: { database: { catalogId: Aws.ACCOUNT_ID, name: props.database.ref } },
      permissions: ['DESCRIBE'],
      permissionsWithGrantOption: [],
    });

    // Do not silently grant access to additional catalog tables introduced in a later slice.
    for (const name of ['application_events', 'waf_events', 'vpc_flow_events', 'cloudtrail_events']) {
      const table = props.tables.find((candidate) => (candidate.tableInput as CfnTable.TableInputProperty).name === name);
      if (!table) throw new Error(`Missing approved Lake Formation table: ${name}.`);
      const grant = new CfnPrincipalPermissions(this, `${name}Read`, {
        principal,
        resource: { table: { catalogId: Aws.ACCOUNT_ID, databaseName: props.database.ref, name: table.ref } },
        permissions: ['SELECT', 'DESCRIBE'],
        permissionsWithGrantOption: [],
      });
      grant.addResourceDependency(databaseGrant);
    }
  }
}
