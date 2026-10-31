import { RemovalPolicy, Validations } from 'aws-cdk-lib';
import { AccessLogFormat, AuthorizationType, EndpointType, LogGroupLogDestination, MethodLoggingLevel,
  CfnRestApi, MockIntegration, PassthroughBehavior, RequestAuthorizer, RequestValidator, ResponseType, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { DeploymentEnvironment, frontendApiAccessLogGroupName } from '../../shared/environment';
import { FrontendOriginAccess } from './frontend-origin-access';

/** Owns the origin-protected REST API and health route; auth integrations are attached after hosting. */
export class FrontendApi extends Construct {
  public readonly api: RestApi;
  public readonly originAuthorizer: RequestAuthorizer;
  public readonly requestValidator: RequestValidator;

  public constructor(scope: Construct, id: string, environment: DeploymentEnvironment, originAccess: FrontendOriginAccess) {
    super(scope, id);
    const removalPolicy = environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const accessLogs = new LogGroup(this, 'AccessLogs', {
      logGroupName: frontendApiAccessLogGroupName(environment), retention: RetentionDays.ONE_WEEK, removalPolicy,
    });
    this.api = new RestApi(this, 'Api', {
      restApiName: `SOC-BOT-${environment.toUpperCase()}-FRONTEND-API`,
      description: 'Origin-protected health/auth routes and session-authenticated streaming chat API.',
      endpointConfiguration: { types: [EndpointType.REGIONAL] }, cloudWatchRole: false,
      deployOptions: {
        stageName: environment, accessLogDestination: new LogGroupLogDestination(accessLogs),
        accessLogFormat: AccessLogFormat.custom(JSON.stringify({
          requestId: '$context.requestId', extendedRequestId: '$context.extendedRequestId',
          httpMethod: '$context.httpMethod', resourcePath: '$context.resourcePath', status: '$context.status',
          responseLength: '$context.responseLength', integrationLatency: '$context.integrationLatency',
        })),
        loggingLevel: MethodLoggingLevel.ERROR, dataTraceEnabled: false,
        throttlingRateLimit: 1, throttlingBurstLimit: 2,
      },
    });
    const transport = { securityPolicy: 'SecurityPolicy_TLS13_1_2_2021_06', endpointAccessMode: 'BASIC' };
    const apiResource = this.api.node.defaultChild as CfnRestApi;
    apiResource.securityPolicy = transport.securityPolicy;
    apiResource.endpointAccessMode = transport.endpointAccessMode;
    this.api.latestDeployment!.addToLogicalId(transport);
    // API-wide defaults preserve each error type's status while preventing cached authorization failures.
    for (const [id, type] of [['SafeClientError', ResponseType.DEFAULT_4XX], ['SafeServerError', ResponseType.DEFAULT_5XX]] as const) {
      this.api.addGatewayResponse(id, { type,
        responseHeaders: { 'Cache-Control': "'no-store'", 'X-Content-Type-Options': "'nosniff'" },
        templates: { 'application/json': '{"message":"Request could not be authorized or processed."}' },
      });
    }
    const executionLogs = new LogGroup(this, 'ExecutionLogs', {
      logGroupName: `API-Gateway-Execution-Logs_${this.api.restApiId}/${environment}`,
      retention: RetentionDays.ONE_WEEK, removalPolicy,
    });
    this.api.deploymentStage.node.addDependency(executionLogs);
    this.originAuthorizer = originAccess.createAuthorizer(this.api);
    // Preserve the original automatically created validator path/ID and reuse it for all routes.
    this.requestValidator = this.api.addRequestValidator('validator', { validateRequestParameters: true, validateRequestBody: true });
    const health = this.api.root.addResource('api').addResource('health').addMethod('GET', new MockIntegration({
      passthroughBehavior: PassthroughBehavior.NEVER,
      requestTemplates: { 'application/json': '{"statusCode":200}' },
      integrationResponses: [{ statusCode: '200', responseTemplates: { 'application/json': '{"status":"ok"}' } }],
    }), {
      authorizationType: AuthorizationType.CUSTOM, authorizer: this.originAuthorizer,
      requestValidator: this.requestValidator, methodResponses: [{ statusCode: '200' }],
    });
    Validations.of(health.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-COG4', reason: 'This GET /api/health uses a zero-cache REQUEST authorizer for CloudFront origin verification. It returns only generic health; user/session validation belongs to the separate auth integrations.',
    });
    Validations.of(this.api.deploymentStage.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-APIG3',
      reason: 'The frontend Regional API uses an exact-route authorizer instead of a Regional WAF association. Auth integrations enforce their browser/session rules; POST /api/chat additionally resolves a durable session in the authorizer. Dev viewer filtering belongs to CloudFront WAF; public-demo abuse controls remain deferred.',
    });
  }
}
