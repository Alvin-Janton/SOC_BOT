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
import { COMMON_COLUMNS, APP_COLUMNS, WAF_COLUMNS, VPC_COLUMNS, CLOUDTRAIL_COLUMNS } from '../../shared/catalog-schema';

export interface ApplicationGlueProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly dataBucket: Bucket;
}

// Shared meanings are overridden below where a source uses a different mapping.
const COMMON_COLUMN_COMMENTS: Record<string, string> = {
  event_uid: 'SHA-256 of source, raw object key, and native record ID; repeated IDs within one object can share this value. Not a unique occurrence or cross-source join key.',
  event_time: 'Source event timestamp normalized to UTC; determines the year/month/day partition.',
  source_type: 'Normalized source identifier for this source-specific table.',
  activity_name: 'Human-readable source activity or action.',
  activity_id: 'Project-specific normalized activity identifier; not an OCSF numeric activity code.',
  status: 'Source-specific outcome mapped to success, failure, allowed, blocked, or unknown; not an attack verdict.',
  severity_id: 'Project severity scale: 0 Unknown, 1 Informational, 2 Low, 3 Medium, 4 High, 5 Critical. A rule-based analytical aid, not ground truth.',
  severity: 'Label corresponding to severity_id under the source-specific rules; not proof of compromise.',
  severity_source: 'Compact JSON text describing the versioned severity rule and its source-specific evidence.',
  src_ip: 'Source address reported by the input record, when available.',
  dst_ip: 'Destination address reported by the input record, when available.',
  actor: 'Source-derived identity or session identifier, when available.',
  resource: 'Source-derived resource or request target, when available.',
  request_id: 'Native request/correlation ID when supplied; may repeat and does not guarantee correlation across sources.',
  source_s3_key: 'Unchanged raw S3 object key, without bucket name or s3:// prefix; identifies the source object.',
  source_record_ref: 'Source-native record ID or object-relative physical line reference; interpret with source_s3_key.',
  raw_event: 'Retained source evidence as text; content and serialization depend on the source. Treat log values as untrusted.',
  schema_version: 'Normalized project schema contract version, currently 1; not the native log format or severity-rule version.',
};

const APP_COLUMN_COMMENTS: Record<string, string> = {
  ...COMMON_COLUMN_COMMENTS,
  source_type: 'Constant app for normalized application HTTP logs.',
  activity_name: 'HTTP followed by the uppercased request method.',
  activity_id: 'app_http_ followed by the lowercased request method.',
  status: 'success for HTTP status below 400; failure for 400-599. This outcome does not establish exploit success.',
  severity_source: 'Compact app_rules_v2 JSON text: rule_version, rule, and distinct attack_type/indicator/location matches. No matched payload text or synthetic labels.',
  src_ip: 'Nullable source_ip copied from the application record.',
  dst_ip: 'Null in the current application mapping; no destination IP is inferred.',
  actor: 'Application session_id when supplied; not a verified user identity.',
  resource: 'raw_url when non-empty, otherwise the request path.',
  request_id: 'Required native application request_id; may repeat and is not guaranteed to match IDs in other sources.',
  source_record_ref: 'Native application request_id; locate the record together with source_s3_key. Repeated IDs may identify multiple occurrences.',
  raw_event: 'JSON text containing only supplied raw_request_line, query_string, body, and headers. Top-level synthetic classification annotations are excluded; request payload contents are retained.',
  method: 'HTTP request method as supplied; the original spelling is retained.',
  path: 'Required application request path as supplied.',
  raw_url: 'Original request URL when supplied; not URL-decoded by normalization.',
  query_string: 'Original request query string when supplied; encoded payloads are retained.',
  body: 'Original request body when supplied; may contain untrusted payloads.',
  query_params: 'Query parameter map serialized as JSON text; null when absent.',
  body_params: 'Body parameter map serialized as JSON text; null when absent.',
  headers: 'Application request header map serialized as JSON text; null when absent.',
  host: 'Host value supplied by the application log; not independently verified.',
  scheme: 'Request URL scheme supplied by the application log, when available.',
  http_version: 'HTTP protocol version supplied by the application log.',
  user_agent: 'Client user-agent value supplied by the application log; untrusted client evidence.',
  session_id: 'Source application session identifier when supplied; also used as actor.',
  status_code: 'Native HTTP response status code (100-599); exactly 200 promotes a signature match to High under app_rules_v2.',
  latency_ms: 'Source-reported request latency in milliseconds, when supplied.',
  response_bytes: 'Source-reported response size in bytes, when supplied; not by itself evidence of exfiltration.',
  source_dataset: 'Dataset identifier supplied by the source record; not a maliciousness label.',
  source_geo: 'Source-provided geographic metadata serialized as JSON text; no geolocation lookup is performed.',
  source_account_id: 'Source record account_id, preserved separately from the AWS account hosting this table.',
  source_aws_region: 'Source record aws_region, which need not equal the table deployment Region.',
  source_environment: 'Source record environment label; not the dev/demo deployment environment assigned by CDK.',
  target_service: 'Target service label supplied by the application log.',
  target_instance_id: 'Target instance identifier supplied by the application log.',
  alb_name: 'Application Load Balancer name supplied by the application log.',
};

const WAF_COLUMN_COMMENTS: Record<string, string> = {
  ...COMMON_COLUMN_COMMENTS,
  event_time: 'UTC instant derived from native timestamp epoch milliseconds; any supplied ISO event_time must agree exactly.',
  source_type: 'Constant waf for normalized AWS WAF request logs.',
  activity_name: 'WAF followed by the native action.',
  activity_id: 'waf_ followed by the lowercased native action.',
  status: 'ALLOW maps to allowed, BLOCK to blocked; other native actions map to unknown.',
  severity_source: 'Compact waf_rules_v1 JSON text with rule_version, rule, action, and native rule/label evidence. A matched ALLOW is not proof of exploitation.',
  src_ip: 'Validated client IP from httpRequest.clientIp.',
  dst_ip: 'Null in the current WAF mapping; no destination IP is inferred.',
  actor: 'Null in the current WAF mapping; no request actor is inferred.',
  resource: 'Native httpRequest.uri request target.',
  request_id: 'Native httpRequest.requestId; duplicate occurrences are retained and this ID is not a unique join key.',
  source_record_ref: 'Native httpRequest.requestId within source_s3_key; repeated IDs in one object can identify multiple occurrences.',
  raw_event: 'JSON text of selected native WAF fields and httpRequest evidence, including nested rule details; not the complete input record.',
  timestamp: 'Native WAF timestamp in Unix epoch milliseconds; canonical source for event_time.',
  format_version: 'Native WAF formatVersion, distinct from normalized schema_version.',
  web_acl_id: 'Native webaclId identifying the Web ACL that evaluated the request.',
  action: 'Native WAF action retained as supplied; ALLOW/BLOCK alone does not establish maliciousness.',
  terminating_rule_id: 'Native terminatingRuleId; identifies the terminating rule or default action.',
  terminating_rule_type: 'Native terminatingRuleType describing the terminating rule category.',
  response_code_sent: 'Native responseCodeSent when supplied; do not assume it is the application response status.',
  labels: 'Native WAF labels serialized as JSON text; rule evidence rather than synthetic ground-truth labels.',
  terminating_rule_match_details: 'Native terminatingRuleMatchDetails serialized as JSON text, retaining supplied match locations and matched data.',
  non_terminating_matching_rules: 'Native nonTerminatingMatchingRules serialized as JSON text; retains matches that did not terminate evaluation.',
  rule_group_list: 'Native ruleGroupList serialized as JSON text, retaining nested rule-group match evidence.',
  rate_based_rule_list: 'Native rateBasedRuleList serialized as JSON text, retaining supplied rate-rule evidence.',
  http_source_name: 'Native httpSourceName identifying the AWS service associated with the request.',
  http_source_id: 'Native httpSourceId identifying the protected HTTP source resource.',
  method: 'Native httpRequest.httpMethod as supplied.',
  path: 'Native httpRequest.uri request path; also used as resource.',
  query_string: 'Native httpRequest.args query string, without URL decoding.',
  country: 'Native httpRequest.country value when supplied; no additional geographic inference.',
  headers: 'Native httpRequest.headers list of name/value objects serialized as JSON text; missing headers become an empty list.',
  http_version: 'Native httpRequest.httpVersion when supplied.',
};

const VPC_COLUMN_COMMENTS: Record<string, string> = {
  ...COMMON_COLUMN_COMMENTS,
  event_uid: 'SHA-256 of vpc, raw object key, one-based physical line number, and exact raw line. Identical lines at different positions have distinct IDs.',
  event_time: 'UTC timestamp derived from flow start epoch seconds; determines the partition even if the interval crosses midnight.',
  source_type: 'Constant vpc_flow; the raw and normalized S3 prefixes use vpc.',
  activity_name: 'VPC Flow followed by ACCEPT, REJECT, or UNKNOWN when action is unavailable.',
  activity_id: 'vpc_flow_accept, vpc_flow_reject, or vpc_flow_unknown according to the native action.',
  status: 'ACCEPT maps to allowed, REJECT to blocked, and unavailable action to unknown; not a maliciousness classification.',
  severity_id: 'Fixed 1 (Informational) under vpc_rules_v1, regardless of action, addresses, or traffic counters.',
  severity: 'Fixed Informational; flow records alone do not establish maliciousness.',
  severity_source: 'Compact JSON text with rule_version=vpc_rules_v1, rule=flow_context_only, and the reason flow action and IPs do not establish maliciousness.',
  src_ip: 'Native srcaddr copied to the common envelope; null for an unavailable source address.',
  dst_ip: 'Native dstaddr copied to the common envelope; null for an unavailable destination address.',
  actor: 'Null; the interface owner account is not treated as a request actor.',
  resource: 'Native interface_id when available.',
  request_id: 'Null; version-2 VPC Flow records have no request ID.',
  source_record_ref: 'One-based physical line number within source_s3_key, stored as text; preceding blank or rejected lines still count.',
  raw_event: 'Exact original space-delimited flow line, including its line terminator when present; not JSON.',
  flow_log_version: 'Native flow-log format version; only version 2 is accepted.',
  account_id: 'Source account ID for the network interface owner, kept as text; unknown is retained and unavailable dash becomes null.',
  interface_id: 'Native network interface ID; null when the source field is an unavailable dash.',
  srcaddr: 'Native source IP address; unavailable dash becomes null.',
  dstaddr: 'Native destination IP address; unavailable dash becomes null.',
  srcport: 'Native source port number (0-65535); unavailable dash becomes null.',
  dstport: 'Native destination port number (0-65535); unavailable dash becomes null.',
  protocol: 'Native IP protocol number (0-255), not a protocol name; unavailable dash becomes null.',
  packets: 'Native packet count for the flow interval; unavailable dash becomes null.',
  bytes: 'Native byte count for the flow interval; unavailable dash becomes null. Not an exfiltration verdict.',
  start: 'Required flow start in Unix epoch seconds (UTC); source of event_time and the date partition.',
  end: 'Required flow end in Unix epoch seconds (UTC); must be greater than or equal to start.',
  action: 'Native ACCEPT or REJECT; unavailable dash becomes null. This is a network disposition, not attack severity.',
  log_status: 'Native OK, NODATA, or SKIPDATA collection status; unavailable dash becomes null. Distinct from allowed/blocked status.',
};

const CLOUDTRAIL_COLUMN_COMMENTS: Record<string, string> = {
  ...COMMON_COLUMN_COMMENTS,
  event_time: 'Native eventTime converted to UTC; determines the date partition.',
  source_type: 'Constant cloudtrail for normalized CloudTrail JSONL events.',
  activity_name: 'Native eventName identifying the AWS API or activity.',
  activity_id: 'Lowercased service/event pair with non-alphanumeric runs replaced by underscores; the service omits .amazonaws.com.',
  status: 'failure when errorCode or errorMessage is non-empty, or responseElements.ConsoleLogin is Failure; otherwise success. Missing/null/empty error fields alone do not mark failure.',
  severity_source: 'Compact cloudtrail_rules_v1 JSON text: rule_version, rule, exact indicator field/value matches, and event evidence. Uses synthetic-dataset heuristics, not general threat intelligence.',
  src_ip: 'Native sourceIPAddress text when supplied; may be an IP address or service identifier.',
  dst_ip: 'Null in the current CloudTrail mapping; no destination IP is inferred.',
  actor: 'userIdentity.arn when non-empty, otherwise userIdentity.userName, otherwise null; principalId is not used.',
  resource: 'First non-empty resources[].ARN; otherwise S3 bucket/key URI from requestParameters for S3 events, or null.',
  request_id: 'Nullable native requestID; distinct from eventID and not guaranteed unique.',
  source_record_ref: 'Native eventID within source_s3_key; repeats remain separate occurrences even when event_uid is shared.',
  raw_event: 'Complete original CloudTrail event reserialized as JSON text; includes sparse nested evidence but does not preserve original whitespace or key order.',
  event_version: 'Native eventVersion preserved as text; distinct from normalized schema_version.',
  event_source: 'Native AWS service endpoint from eventSource, such as s3.amazonaws.com.',
  event_name: 'Native API/activity name from eventName; also used as activity_name.',
  aws_region: 'Native awsRegion when supplied; may differ from the catalog deployment Region.',
  user_agent: 'Native userAgent when supplied; reported client evidence, not independently verified.',
  identity_type: 'Native userIdentity.type when supplied.',
  identity_account_id: 'Non-empty userIdentity.accountId, falling back to recipientAccountId; source evidence rather than the deployment account.',
  identity_user_name: 'Native userIdentity.userName when supplied; not inferred from an ARN or session issuer.',
  error_code: 'Native errorCode; a non-empty value marks failure even without an error message.',
  error_message: 'Native errorMessage; a non-empty value marks failure even without an error code.',
  s3_bucket_name: 'requestParameters.bucketName only for eventSource=s3.amazonaws.com; otherwise null.',
  s3_object_key: 'requestParameters.key only for eventSource=s3.amazonaws.com; otherwise null.',
  s3_prefix: 'requestParameters.prefix only for eventSource=s3.amazonaws.com; otherwise null. May describe a listing, not a single object.',
  bytes_transferred_out: 'Nullable byte count from additionalEventData.bytesTransferredOut. Positive bytes qualify for Critical only with a known indicator and successful S3 GetObject under the synthetic-data rules.',
};

const PARTITION_COLUMN_COMMENTS: Record<string, string> = {
  year: 'Projected UTC event_time year (YYYY), stored in the S3 partition path rather than the Parquet row.',
  month: 'Projected UTC event_time month (MM, 01-12), stored in the S3 partition path rather than the Parquet row.',
  day: 'Projected UTC event_time day of month (DD, 01-31), stored in the S3 partition path rather than the Parquet row.',
};

/** Defines one shared on-demand job with separate application, WAF, VPC Flow, and CloudTrail tables. */
export class ApplicationGlue extends Construct {
  public readonly database: CfnDatabase;
  public readonly tables: CfnTable[];

  public constructor(scope: Construct, id: string, props: ApplicationGlueProps) {
    super(scope, id);
    const { deploymentEnvironment: environment, dataBucket } = props;
    const upper = environment.toUpperCase();
    const jobName = `SOC-BOT-${upper}-NORMALIZE-APP`;
    const logPrefix = `/aws-glue/${jobName}`;
    const dataArn = dataBucket.bucketArn;
    const sources = ['app', 'waf', 'vpc', 'cloudtrail'];

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
      conditions: { StringLike: { 's3:prefix': sources.flatMap((source) =>
        ['raw', 'normalized', 'quarantine'].flatMap((prefix) =>
          [`${prefix}/${source}`, `${prefix}/${source}/*`])) } },
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject'], resources: sources.map((source) => `${dataArn}/raw/${source}/*`),
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: sources.flatMap((source) =>
        [`${dataArn}/normalized/${source}/*`, `${dataArn}/quarantine/${source}/*`]),
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
    this.database = database;
    const table = new CfnTable(this, 'ApplicationTable', {
      catalogId: Aws.ACCOUNT_ID,
      databaseName,
      tableInput: {
        name: 'application_events',
        description: 'One normalized HTTP request occurrence per valid raw/app/ JSONL record. Preserves request/response evidence and object provenance; top-level synthetic classification annotations are excluded. app_rules_v2 severity is a heuristic, not proof of exploitation.',
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
        partitionKeys: ['year', 'month', 'day'].map((name) => ({ name, type: 'string', comment: PARTITION_COLUMN_COMMENTS[name] })),
        storageDescriptor: {
          columns: [...COMMON_COLUMNS, ...APP_COLUMNS].map(([name, type]) => ({ name, type, comment: APP_COLUMN_COMMENTS[name] })),
          location: `s3://${dataBucket.bucketName}/normalized/app/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
        },
      },
    });
    table.addResourceDependency(database);

    const wafTable = new CfnTable(this, 'WafTable', {
      catalogId: Aws.ACCOUNT_ID,
      databaseName,
      tableInput: {
        name: 'waf_events',
        description: 'One normalized WAF request occurrence per valid raw/waf/ JSONL record, retaining native action and rule evidence. Duplicate request IDs remain separate rows. waf_rules_v1 severity and an allowed rule match do not prove successful exploitation.',
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
          'storage.location.template': `s3://${dataBucket.bucketName}/normalized/waf/year=\${year}/month=\${month}/day=\${day}/`,
        },
        partitionKeys: ['year', 'month', 'day'].map((name) => ({ name, type: 'string', comment: PARTITION_COLUMN_COMMENTS[name] })),
        storageDescriptor: {
          columns: [...COMMON_COLUMNS, ...WAF_COLUMNS].map(([name, type]) => ({ name, type, comment: WAF_COLUMN_COMMENTS[name] })),
          location: `s3://${dataBucket.bucketName}/normalized/waf/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
        },
      },
    });
    wafTable.addResourceDependency(database);

    const vpcTable = new CfnTable(this, 'VpcFlowTable', {
      catalogId: Aws.ACCOUNT_ID,
      databaseName,
      tableInput: {
        name: 'vpc_flow_events',
        description: 'One normalized flow-interval record per valid version-2, 14-field raw/vpc/ .log line, with object-relative line provenance. Records are not individual requests or packets. Severity is fixed Informational; flow records alone do not establish maliciousness.',
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
          'storage.location.template': `s3://${dataBucket.bucketName}/normalized/vpc/year=\${year}/month=\${month}/day=\${day}/`,
        },
        partitionKeys: ['year', 'month', 'day'].map((name) => ({ name, type: 'string', comment: PARTITION_COLUMN_COMMENTS[name] })),
        storageDescriptor: {
          columns: [...COMMON_COLUMNS, ...VPC_COLUMNS].map(([name, type]) => ({ name, type, comment: VPC_COLUMN_COMMENTS[name] })),
          location: `s3://${dataBucket.bucketName}/normalized/vpc/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
        },
      },
    });
    vpcTable.addResourceDependency(database);

    const cloudtrailTable = new CfnTable(this, 'CloudTrailTable', {
      catalogId: Aws.ACCOUNT_ID,
      databaseName,
      tableInput: {
        name: 'cloudtrail_events',
        description: 'One normalized AWS API/activity event per valid raw/cloudtrail/ JSONL record, preserving eventID and original event evidence. Repeated event IDs remain separate rows. cloudtrail_rules_v1 severity follows current project synthetic-data heuristics, not proof of compromise.',
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
          'storage.location.template': `s3://${dataBucket.bucketName}/normalized/cloudtrail/year=\${year}/month=\${month}/day=\${day}/`,
        },
        partitionKeys: ['year', 'month', 'day'].map((name) => ({ name, type: 'string', comment: PARTITION_COLUMN_COMMENTS[name] })),
        storageDescriptor: {
          columns: [...COMMON_COLUMNS, ...CLOUDTRAIL_COLUMNS].map(([name, type]) => ({ name, type, comment: CLOUDTRAIL_COLUMN_COMMENTS[name] })),
          location: `s3://${dataBucket.bucketName}/normalized/cloudtrail/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
        },
      },
    });
    cloudtrailTable.addResourceDependency(database);
    this.tables = [table, wafTable, vpcTable, cloudtrailTable];

    const job = new CfnJob(this, 'NormalizeApplicationJob', {
      name: jobName,
      role: role.roleArn,
      glueVersion: '5.0',
      command: { name: 'glueetl', pythonVersion: '3', scriptLocation: script.s3ObjectUrl },
      defaultArguments: {
        '--job-language': 'python',
        // Avoid EMRFS legacy folder-marker probes outside the supported source prefixes.
        '--conf': 'spark.hadoop.fs.s3.useDirectoryHeaderAsFolderObject=true --conf spark.hadoop.fs.s3.folderObject.autoAction.disabled=true',
        '--extra-py-files': library.s3ObjectUrl,
        '--input_prefix': `s3://${dataBucket.bucketName}/raw/`,
        '--output_prefix': `s3://${dataBucket.bucketName}/normalized/`,
        '--quarantine_prefix': `s3://${dataBucket.bucketName}/quarantine/`,
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
      for (const source of sources) {
        Validations.of(policyResource).acknowledge({
          id: `AwsSolutions-IAM5[Resource::<${bucketLogicalId}.Arn>/${prefix}/${source}/*]`,
          reason: `The Glue job accesses only the ${prefix}/${source}/ objects of its environment data bucket.`,
        });
      }
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
