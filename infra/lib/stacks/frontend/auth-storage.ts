import { RemovalPolicy, Validations } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { DeploymentEnvironment } from '../../shared/environment';

/** Owns USER#sub metadata (without TTL) and SESSION#sha256 records expiring on expires_at. */
export class AuthStorage extends Construct {
  public readonly table: Table;

  public constructor(scope: Construct, id: string, environment: DeploymentEnvironment) {
    super(scope, id);
    this.table = new Table(this, 'Table', {
      tableName: `SOC-BOT-${environment.toUpperCase()}-AUTH-SESSIONS`,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expires_at',
      removalPolicy: environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    Validations.of(this.table.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-DDB3',
      reason: 'PITR is intentionally deferred in the approved auth foundation. Demo retention protects teardown only, not data loss; backup/recovery and fail-closed auth-state restoration require a later review.',
    });
  }
}
