import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { CfnWorkGroup } from 'aws-cdk-lib/aws-athena';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DeploymentEnvironment } from '../../shared/environment';
import { AthenaQueryTool } from './athena-query-tool';
import { ChatHistory } from './chat-history';
import { ChatOrchestrator } from './chat-orchestrator';
import { ChatApi } from './chat-api';
import { LakeFormationGrants } from './lake-formation-grants';

export interface AiStackProps extends StackProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly dataBucket: IBucket;
  readonly workgroup: CfnWorkGroup;
  readonly database: CfnDatabase;
  readonly tables: readonly CfnTable[];
  readonly maxQueryWindowDays?: number;
  readonly devAllowedClientCidr?: string;
}

/** Owns private investigation tools, conversation storage, and environment-specific streaming chat. */
export class AiStack extends Stack {
  public readonly queryTool: AthenaQueryTool;
  public readonly chatHistoryTable: Table;
  public readonly chatOrchestrator: ChatOrchestrator;
  public readonly chatApi: ChatApi;

  public constructor(scope: Construct, id: string, props: AiStackProps) {
    super(scope, id, props);
    this.chatHistoryTable = new ChatHistory(this, 'ChatHistory', {
      deploymentEnvironment: props.deploymentEnvironment,
    }).table;
    this.queryTool = new AthenaQueryTool(this, 'AthenaQueryTool', props);
    new LakeFormationGrants(this, 'LakeFormationGrants', {
      database: props.database,
      tables: props.tables,
      queryRoleArn: this.queryTool.role.roleArn,
    });
    this.chatOrchestrator = new ChatOrchestrator(this, 'ChatOrchestrator', {
      deploymentEnvironment: props.deploymentEnvironment,
      chatHistoryTable: this.chatHistoryTable,
      queryToolFunction: this.queryTool.function,
      databaseName: props.database.ref,
      maxQueryWindowDays: props.maxQueryWindowDays,
    });
    this.chatApi = new ChatApi(this, 'ChatApi', {
      deploymentEnvironment: props.deploymentEnvironment,
      orchestratorFunction: this.chatOrchestrator.function,
      devAllowedClientCidr: props.devAllowedClientCidr,
    });
    Tags.of(this).add('Project', 'SOC_BOT');
    Tags.of(this).add('Environment', props.deploymentEnvironment);
    Tags.of(this).add('ManagedBy', 'CDK');
  }
}
