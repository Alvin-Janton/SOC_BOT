import { Aws, CfnOutput, Duration, RemovalPolicy, Tags, Validations } from 'aws-cdk-lib';
import {
  AccessLogFormat, AuthorizationType, CfnRestApi, EndpointType, IpAddressType, JsonSchemaType,
  JsonSchemaVersion, LambdaIntegration, LogGroupLogDestination, MethodLoggingLevel,
  ResponseTransferMode, RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnIPSet, CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { isIP } from 'node:net';
import { chatApiAccessLogGroupName, DeploymentEnvironment } from '../../shared/environment';

export interface ChatApiProps {
  readonly deploymentEnvironment: DeploymentEnvironment;
  readonly orchestratorFunction: IFunction;
  readonly devAllowedClientCidr?: string;
}

/** Validates the required dev context without including the caller address in errors. */
export function devClientCidr(value: unknown): { cidr: string; version: 'IPV4' | 'IPV6' } {
  if (typeof value !== 'string') throw new Error('Set CDK context devAllowedClientCidr to a valid IPv4 or IPv6 CIDR.');
  const parts = value.split('/');
  const version = isIP(parts[0]);
  const prefix = Number(parts[1]);
  if (parts.length !== 2 || !version || parts[0].includes('%') || !/^\d{1,3}$/.test(parts[1])
    || prefix < 1 || prefix > (version === 4 ? 32 : 128)) {
    throw new Error('CDK context devAllowedClientCidr must be a valid CIDR; WAF does not support /0.');
  }
  return { cidr: `${parts[0]}/${prefix}`, version: version === 4 ? 'IPV4' : 'IPV6' };
}

/** Exposes environment-scoped NDJSON chat; dev is source-IP gated while Cognito is deferred. */
export class ChatApi extends Construct {
  public readonly api: RestApi;

  public constructor(scope: Construct, id: string, props: ChatApiProps) {
    super(scope, id);
    const environment = props.deploymentEnvironment;
    const name = `SOC-BOT-${environment.toUpperCase()}-CHAT`;
    const removalPolicy = environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const client = environment === 'dev' ? devClientCidr(props.devAllowedClientCidr) : undefined;
    const accessLogs = new LogGroup(this, 'AccessLogs', {
      logGroupName: chatApiAccessLogGroupName(environment),
      retention: RetentionDays.ONE_WEEK, removalPolicy,
    });
    this.api = new RestApi(this, 'Api', {
      restApiName: name,
      description: `SOC Bot ${environment} response-streaming chat API; Cognito integration is deferred.`,
      endpointConfiguration: { types: [EndpointType.REGIONAL], ipAddressType: IpAddressType.DUAL_STACK },
      // The foundation owns the only Regional AWS::ApiGateway::Account and its logging role.
      cloudWatchRole: false,
      deployOptions: {
        stageName: environment,
        accessLogDestination: new LogGroupLogDestination(accessLogs),
        accessLogFormat: AccessLogFormat.custom(JSON.stringify({
          requestId: '$context.requestId', extendedRequestId: '$context.extendedRequestId',
          httpMethod: '$context.httpMethod', resourcePath: '$context.resourcePath',
          status: '$context.status', responseLength: '$context.responseLength',
          integrationLatency: '$context.integrationLatency',
        })),
        loggingLevel: MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        throttlingRateLimit: 1,
        throttlingBurstLimit: 2,
      },
    });
    const transport = { securityPolicy: 'SecurityPolicy_TLS13_1_2_2021_06', endpointAccessMode: 'BASIC' };
    const apiResource = this.api.node.defaultChild as CfnRestApi;
    apiResource.securityPolicy = transport.securityPolicy;
    apiResource.endpointAccessMode = transport.endpointAccessMode;
    this.api.latestDeployment!.addToLogicalId(transport);
    // API Gateway fixes this name; create/tag/retain the group before the stage can write logs.
    const executionLogs = new LogGroup(this, 'ExecutionLogs', {
      logGroupName: `API-Gateway-Execution-Logs_${this.api.restApiId}/${environment}`,
      retention: RetentionDays.ONE_WEEK, removalPolicy,
    });
    this.api.deploymentStage.node.addDependency(executionLogs);
    const requestModel = this.api.addModel('ChatRequestModel', {
      modelName: 'ChatRequest', contentType: 'application/json',
      schema: {
        schema: JsonSchemaVersion.DRAFT4, type: JsonSchemaType.OBJECT,
        additionalProperties: false, required: ['turnId', 'message'],
        properties: {
          conversationId: { type: JsonSchemaType.STRING, minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
          turnId: { type: JsonSchemaType.STRING, pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
          message: { type: JsonSchemaType.STRING, minLength: 1, maxLength: 8192, pattern: '\\S' },
        },
      },
    });
    const method = this.api.root.addResource('chat').addMethod('POST', new LambdaIntegration(props.orchestratorFunction, {
      proxy: true, allowTestInvoke: false,
      responseTransferMode: ResponseTransferMode.STREAM,
      // STREAM permits up to 15 minutes without the buffered integration's quota increase.
      timeout: Duration.minutes(15),
    }), {
      authorizationType: AuthorizationType.NONE,
      requestModels: { 'application/json': requestModel },
      requestValidatorOptions: { validateRequestBody: true, validateRequestParameters: true },
    });
    Validations.of(method.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-APIG4',
      reason: environment === 'dev'
        ? 'Explicitly approved temporary unauthenticated POST /chat: the dev stage is source-IP gated by WAF and uses a server-owned identity until Cognito is integrated.'
        : 'Explicitly approved deferred Cognito authorization on demo POST /chat. Demo has a shared temporary owner and no WAF; the operator will not deploy demo until application authentication/security is complete.',
    });
    Validations.of(method.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-COG4',
      reason: 'Cognito authorization is explicitly deferred for this specific POST /chat method. Dev uses a temporary WAF source-IP gate; the operator will not deploy the unprotected demo endpoint until authentication/security is complete.',
    });

    if (client) {
      const ipSet = new CfnIPSet(this, 'ClientIpSet', {
        name: `${name}-CLIENTS`, scope: 'REGIONAL',
        ipAddressVersion: client.version, addresses: [client.cidr],
      });
      const visibilityConfig = {
        cloudWatchMetricsEnabled: true, sampledRequestsEnabled: false, metricName: `${name}-ALLOWLIST`,
      };
      const webAcl = new CfnWebACL(this, 'WebAcl', {
        name: `${name}-ALLOWLIST`, scope: 'REGIONAL', defaultAction: { block: {} }, visibilityConfig,
        rules: [{
          name: 'AllowConfiguredClient', priority: 0, action: { allow: {} },
          statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } },
          visibilityConfig: { ...visibilityConfig, metricName: `${name}-CLIENT` },
        }],
      });
      const association = new CfnWebACLAssociation(this, 'WebAclAssociation', {
        webAclArn: webAcl.attrArn,
        resourceArn: `arn:${Aws.PARTITION}:apigateway:${Aws.REGION}::/restapis/${this.api.restApiId}/stages/${environment}`,
      });
      association.node.addDependency(this.api.deploymentStage);
    } else {
      Validations.of(this.api.deploymentStage.node.defaultChild!).acknowledge({
        id: 'AwsSolutions-APIG3',
        reason: 'The approved demo design intentionally omits WAF; deployment is deferred until Cognito/security is in place. API throttling is not authentication or a hard cost ceiling.',
      });
    }
    Tags.of(this).add('Project', 'SOC_BOT');
    Tags.of(this).add('Environment', environment);
    Tags.of(this).add('ManagedBy', 'CDK');
    new CfnOutput(this, 'ChatUrl', { value: this.api.urlForPath('/chat') });
  }
}
