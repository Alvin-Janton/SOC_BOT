import { RemovalPolicy, Validations } from 'aws-cdk-lib';
import { AttributeType, BillingMode, CfnTable, ProjectionType, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { DeploymentEnvironment } from '../../shared/environment';

export interface ChatHistoryProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
}

/**
 * Owns the environment's conversation table and sparse user-listing index.
 *
 * Application records use PK = CONV#<conversationId> with SK = META,
 * EVT#<UTC-created_at>#<zero-padded-event_sequence>#<eventId>, or
 * SUMMARY#<UTC-created_at>#<zero-padded-event_sequence>#<summaryId>.
 * Only metadata items carry GSI1PK = USER#<trusted-owner-id> and
 * GSI1SK = CONV#<updated_at>#<conversationId>.
 * DynamoDB enforces key types, not these values; item validation and sequence
 * allocation belong to the future application implementation.
 */
export class ChatHistory extends Construct {
  public readonly table: Table;

  /** Provisions conversation storage without runtime grants or automatic record expiry. */
  public constructor(scope: Construct, id: string, props: ChatHistoryProps) {
    super(scope, id);
    const { deploymentEnvironment } = props;
    this.table = new Table(this, 'Table', {
      tableName: `SOC-BOT-${deploymentEnvironment.toUpperCase()}-CHAT-HISTORY`,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.DEFAULT,
      removalPolicy: deploymentEnvironment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    Validations.of(this.table.node.defaultChild as CfnTable).acknowledge({
      id: 'AwsSolutions-DDB3',
      reason: 'PITR is intentionally disabled by the approved chat-history configuration. Dev is disposable; demo retention protects stack teardown only, not data loss. Backup configuration remains a separate reviewed change.',
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ['conversation_id', 'title', 'created_at', 'updated_at'],
    });
  }
}
