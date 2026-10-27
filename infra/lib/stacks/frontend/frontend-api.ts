import { RemovalPolicy, Validations } from 'aws-cdk-lib';
import { AccessLogFormat, AuthorizationType, EndpointType, LogGroupLogDestination, MethodLoggingLevel,
  MockIntegration, PassthroughBehavior, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { DeploymentEnvironment, frontendApiAccessLogGroupName } from '../../shared/environment';

/** Owns an independent health-only API; it neither invokes auth source nor the AI stack. */
export class FrontendApi extends Construct {
  public readonly api: RestApi;

  public constructor(scope: Construct, id: string, environment: DeploymentEnvironment) {
    super(scope, id);
    const removalPolicy = environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const accessLogs = new LogGroup(this, 'AccessLogs', {
      logGroupName: frontendApiAccessLogGroupName(environment), retention: RetentionDays.ONE_WEEK, removalPolicy,
    });
    this.api = new RestApi(this, 'Api', {
      restApiName: `SOC-BOT-${environment.toUpperCase()}-FRONTEND-API`,
      description: 'Independent generic health API; authentication and chat integration are not active.',
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
    const executionLogs = new LogGroup(this, 'ExecutionLogs', {
      logGroupName: `API-Gateway-Execution-Logs_${this.api.restApiId}/${environment}`,
      retention: RetentionDays.ONE_WEEK, removalPolicy,
    });
    this.api.deploymentStage.node.addDependency(executionLogs);
    const health = this.api.root.addResource('api').addResource('health').addMethod('GET', new MockIntegration({
      passthroughBehavior: PassthroughBehavior.NEVER,
      requestTemplates: { 'application/json': '{"statusCode":200}' },
      integrationResponses: [{ statusCode: '200', responseTemplates: { 'application/json': '{"status":"ok"}' } }],
    }), {
      authorizationType: AuthorizationType.NONE,
      requestValidatorOptions: { validateRequestParameters: true, validateRequestBody: true }, methodResponses: [{ statusCode: '200' }],
    });
    for (const rule of ['APIG4', 'COG4']) Validations.of(health.node.defaultChild!).acknowledge({
      id: `AwsSolutions-${rule}`, reason: 'Only this GET /api/health method is intentionally public: fixed generic MOCK response, no runtime, auth details, user data or AI integration.',
    });
    Validations.of(this.api.deploymentStage.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-APIG3',
      reason: 'This separate stage exposes only a generic MOCK health response. Auth routes, user data, abuse-control design and public-demo activation remain deferred; the working chat WAF is untouched.',
    });
  }
}
