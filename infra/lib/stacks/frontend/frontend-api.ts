import { RemovalPolicy, Validations } from 'aws-cdk-lib';
import { AccessLogFormat, AuthorizationType, EndpointType, LogGroupLogDestination, MethodLoggingLevel,
  CfnRestApi, MockIntegration, PassthroughBehavior, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { DeploymentEnvironment, frontendApiAccessLogGroupName } from '../../shared/environment';
import { FrontendOriginAccess } from './frontend-origin-access';

/** Owns a health-only API protected by origin verification, without user authentication or AI routing. */
export class FrontendApi extends Construct {
  public readonly api: RestApi;

  public constructor(scope: Construct, id: string, environment: DeploymentEnvironment, originAccess: FrontendOriginAccess) {
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
    const transport = { securityPolicy: 'SecurityPolicy_TLS13_1_2_2021_06', endpointAccessMode: 'BASIC' };
    const apiResource = this.api.node.defaultChild as CfnRestApi;
    apiResource.securityPolicy = transport.securityPolicy;
    apiResource.endpointAccessMode = transport.endpointAccessMode;
    this.api.latestDeployment!.addToLogicalId(transport);
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
      authorizationType: AuthorizationType.CUSTOM, authorizer: originAccess.createAuthorizer(this.api),
      requestValidatorOptions: { validateRequestParameters: true, validateRequestBody: true }, methodResponses: [{ statusCode: '200' }],
    });
    Validations.of(health.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-COG4', reason: 'This GET /api/health uses a zero-cache REQUEST authorizer for CloudFront origin verification. It returns only generic health; Cognito user/session authentication remains a separate slice.',
    });
    Validations.of(this.api.deploymentStage.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-APIG3',
      reason: 'The frontend Regional API uses an exact-method origin-secret authorizer instead of a Regional WAF association. Dev viewer filtering is owned by the CloudFront WebACL; user authentication and demo release remain deferred.',
    });
  }
}
