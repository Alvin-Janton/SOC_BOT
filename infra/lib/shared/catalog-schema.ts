export type CatalogColumnType = 'string' | 'timestamp' | 'int' | 'bigint';
export type CatalogColumns = ReadonlyArray<readonly [string, CatalogColumnType]>;

// One column contract feeds both the catalog definitions and query allowlists.
export const COMMON_COLUMNS: CatalogColumns = [
  ['event_uid', 'string'], ['event_time', 'timestamp'], ['source_type', 'string'],
  ['activity_name', 'string'], ['activity_id', 'string'], ['status', 'string'],
  ['severity_id', 'int'], ['severity', 'string'], ['severity_source', 'string'],
  ['src_ip', 'string'], ['dst_ip', 'string'], ['actor', 'string'], ['resource', 'string'],
  ['request_id', 'string'], ['source_s3_key', 'string'], ['source_record_ref', 'string'],
  ['raw_event', 'string'], ['schema_version', 'int'],
];
export const APP_COLUMNS: CatalogColumns = [
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
export const WAF_COLUMNS: CatalogColumns = [
  ['timestamp', 'bigint'], ['format_version', 'int'], ['web_acl_id', 'string'],
  ['action', 'string'], ['terminating_rule_id', 'string'], ['terminating_rule_type', 'string'],
  ['response_code_sent', 'int'], ['labels', 'string'], ['terminating_rule_match_details', 'string'],
  ['non_terminating_matching_rules', 'string'], ['rule_group_list', 'string'], ['rate_based_rule_list', 'string'],
  ['http_source_name', 'string'], ['http_source_id', 'string'], ['method', 'string'],
  ['path', 'string'], ['query_string', 'string'], ['country', 'string'], ['headers', 'string'], ['http_version', 'string'],
];
export const VPC_COLUMNS: CatalogColumns = [
  ['flow_log_version', 'int'], ['account_id', 'string'], ['interface_id', 'string'],
  ['srcaddr', 'string'], ['dstaddr', 'string'], ['srcport', 'int'], ['dstport', 'int'],
  ['protocol', 'int'], ['packets', 'bigint'], ['bytes', 'bigint'],
  ['start', 'bigint'], ['end', 'bigint'], ['action', 'string'], ['log_status', 'string'],
];
export const CLOUDTRAIL_COLUMNS: CatalogColumns = [
  ['event_version', 'string'], ['event_source', 'string'], ['event_name', 'string'],
  ['aws_region', 'string'], ['user_agent', 'string'], ['identity_type', 'string'],
  ['identity_account_id', 'string'], ['identity_user_name', 'string'], ['error_code', 'string'],
  ['error_message', 'string'], ['s3_bucket_name', 'string'], ['s3_object_key', 'string'],
  ['s3_prefix', 'string'], ['bytes_transferred_out', 'bigint'],
];

export const TABLE_COLUMNS = {
  application_events: [...COMMON_COLUMNS, ...APP_COLUMNS],
  waf_events: [...COMMON_COLUMNS, ...WAF_COLUMNS],
  vpc_flow_events: [...COMMON_COLUMNS, ...VPC_COLUMNS],
  cloudtrail_events: [...COMMON_COLUMNS, ...CLOUDTRAIL_COLUMNS],
} as const;

export type TableName = keyof typeof TABLE_COLUMNS;
