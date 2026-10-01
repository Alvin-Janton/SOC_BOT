import { Aws, Duration, RemovalPolicy, Stack, Tags, Validations } from 'aws-cdk-lib';
import { CfnDatabase, CfnJob, CfnTable } from 'aws-cdk-lib/aws-glue';
import { CfnPolicy, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket, CfnBucket } from 'aws-cdk-lib/aws-s3';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DeploymentEnvironment } from '../../shared/environment';

export interface ApplicationGlueProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly dataBucket: Bucket;
}

const COMMON_COLUMNS: Array<[string, string]> = [
  ['event_uid', 'string'], ['event_time', 'timestamp'], ['source_type', 'string'],
  ['activity_name', 'string'], ['activity_id', 'string'], ['status', 'string'],
  ['severity_id', 'int'], ['severity', 'string'], ['severity_source', 'string'],
  ['src_ip', 'string'], ['dst_ip', 'string'], ['actor', 'string'], ['resource', 'string'],
  ['request_id', 'string'], ['source_s3_key', 'string'], ['source_record_ref', 'string'],
  ['raw_event', 'string'], ['schema_version', 'int'],
];
const APP_COLUMNS: Array<[string, string]> = [
  ['method', 'string'], ['path', 'string'], ['raw_url', 'string'],
  ['query_string', 'string'], ['body', 'string'], ['query_params', 'string'],
  ['body_params', 'string'], ['headers', 'string'], ['host', 'string'],
  ['scheme', 'string'], ['http_version', 'string'], ['user_agent', 'string'],
  ['session_id', 'string'], ['status_code', 'int'], ['latency_ms', 'int'],
  ['response_bytes', 'bigint'], ['source_dataset', 'string'],
  ['source_geo', 'string'],
  ['source_account_id', 'string'], ['source_aws_region', 'string'], ['source_environment', 'string'],
  ['target_service', 'string'], ['target_instance_id', 'string'], ['alb_name', 'string'],
];

/** Defines one on-demand application job and its projected Parquet catalog table. */
export class ApplicationGlue extends Construct {
  public constructor(scope: Construct, id: string, props: ApplicationGlueProps) {
    super(scope, id);
    const { deploymentEnvironment: environment, dataBucket } = props;
    const upper = environment.toUpperCase();
    const jobName = `SOC-BOT-${upper}-NORMALIZE-APP`;
    const logPrefix = `/aws-glue/${jobName}`;
    const dataArn = dataBucket.bucketArn;

    const role = new Role(this, 'JobRole', {
      roleName: `SOC_BOT_${upper}_RUNTIME_GLUE_APP`,
      assumedBy: new ServicePrincipal('glue.amazonaws.com'),
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(
        this, 'GlueBoundary',
        `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:policy/SOC_BOT_${upper}_BOUNDARY_GLUE`,
      ),
    });
    Tags.of(role).add('SOCBOTAccessClass', 'glue');
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:GetBucketLocation'], resources: [dataArn],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:ListBucket'], resources: [dataArn],
      conditions: { StringLike: { 's3:prefix': [
        'raw/app', 'raw/app/*', 'normalized/app', 'normalized/app/*',
        'quarantine/app', 'quarantine/app/*',
      ] } },
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject'], resources: [`${dataArn}/raw/app/*`],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [`${dataArn}/normalized/app/*`, `${dataArn}/quarantine/app/*`],
    }));

    const root = this.glueSourceDirectory();
    const script = new Asset(this, 'JobScript', { path: resolve(root, 'job.py') });
    const library = new Asset(this, 'JobLibrary', {
      path: root,
      exclude: ['job.py', 'test', 'test/**', '__pycache__', '__pycache__/**', '**/__pycache__', '**/__pycache__/**', '*.pyc', '**/*.pyc'],
    });
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [script, library].map((asset) =>
        `arn:${Aws.PARTITION}:s3:::${asset.s3BucketName}/${asset.s3ObjectKey}`),
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${logPrefix}/error:*`,
        `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${logPrefix}/output:*`,
      ],
    }));
    for (const suffix of ['error', 'output']) {
      new LogGroup(this, `${suffix}LogGroup`, {
        logGroupName: `${logPrefix}/${suffix}`,
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      });
    }

    const databaseName = `soc_bot_${environment}_security`;
    const database = new CfnDatabase(this, 'Database', {
      catalogId: Aws.ACCOUNT_ID,
      databaseInput: { name: databaseName, description: `${environment} normalized security events` },
    });
    const table = new CfnTable(this, 'ApplicationTable', {
      catalogId: Aws.ACCOUNT_ID,
      databaseName,
      tableInput: {
        name: 'application_events',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          classification: 'parquet',
          'projection.enabled': 'true',
          'projection.year.type': 'integer',
          'projection.year.range': '2026,2036',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'storage.location.template': `s3://${dataBucket.bucketName}/normalized/app/year=\${year}/month=\${month}/day=\${day}/`,
        },
        partitionKeys: ['year', 'month', 'day'].map((name) => ({ name, type: 'string' })),
        storageDescriptor: {
          columns: [...COMMON_COLUMNS, ...APP_COLUMNS].map(([name, type]) => ({ name, type })),
          location: `s3://${dataBucket.bucketName}/normalized/app/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
        },
      },
    });
    table.addResourceDependency(database);

    const job = new CfnJob(this, 'NormalizeApplicationJob', {
      name: jobName,
      role: role.roleArn,
      glueVersion: '5.0',
      command: { name: 'glueetl', pythonVersion: '3', scriptLocation: script.s3ObjectUrl },
      defaultArguments: {
        '--job-language': 'python',
        // Avoid EMRFS legacy folder-marker probes outside the allowed app prefixes.
        '--conf': 'spark.hadoop.fs.s3.useDirectoryHeaderAsFolderObject=true --conf spark.hadoop.fs.s3.folderObject.autoAction.disabled=true',
        '--extra-py-files': library.s3ObjectUrl,
        '--input_prefix': `s3://${dataBucket.bucketName}/raw/app/`,
        '--output_prefix': `s3://${dataBucket.bucketName}/normalized/app/`,
        '--quarantine_prefix': `s3://${dataBucket.bucketName}/quarantine/app/`,
        '--mode': 'full',
        '--schema_version': '1',
        '--max_invalid_fraction': '0.05',
        '--custom-logGroup-prefix': logPrefix,
        '--enable-job-insights': 'false',
        '--job-bookmark-option': 'job-bookmark-disable',
      },
      executionProperty: { maxConcurrentRuns: 1 },
      maxRetries: 0,
      numberOfWorkers: 2,
      workerType: 'G.1X',
      timeout: Duration.minutes(30).toMinutes(),
    });
    Validations.of(job).acknowledge({
      id: 'AwsSolutions-GL1',
      reason: 'CloudWatch Logs provides default at-rest encryption; a customer-managed KMS key and its cost are outside this initial on-demand slice.',
    });
    Validations.of(job).acknowledge({
      id: 'AwsSolutions-GL3',
      reason: 'Glue bookmarks are disabled. Explicit UTC dates and partition replacement provide rerun control without stored bookmark state.',
    });

    const policyResource = role.node.findChild('DefaultPolicy').node.defaultChild as CfnPolicy;
    const bucketLogicalId = Stack.of(this).getLogicalId(dataBucket.node.defaultChild as CfnBucket);
    for (const prefix of ['raw', 'normalized', 'quarantine']) {
      Validations.of(policyResource).acknowledge({
        id: `AwsSolutions-IAM5[Resource::<${bucketLogicalId}.Arn>/${prefix}/app/*]`,
        reason: `The Glue job accesses only the ${prefix}/app/ objects of its environment data bucket.`,
      });
    }
    for (const suffix of ['error', 'output']) {
      Validations.of(policyResource).acknowledge({
        id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:${logPrefix}/${suffix}:*]`,
        reason: 'Glue creates per-run streams only inside its environment-qualified log group.',
      });
    }
  }

  private glueSourceDirectory(): string {
    const candidates = [resolve(__dirname, '../../../../glue'), resolve(__dirname, '../../../../../glue')];
    const root = candidates.find((candidate) => existsSync(resolve(candidate, 'job.py')));
    if (!root) {
      throw new Error('Application Glue source package was not found');
    }
    return root;
  }
}
