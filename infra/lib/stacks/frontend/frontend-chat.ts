import { Aws, Duration, Validations } from 'aws-cdk-lib';
import { AuthorizationType, IRequestValidator, JsonSchemaType, JsonSchemaVersion, LambdaIntegration,
  RequestAuthorizer, ResponseTransferMode, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { CfnPermission, IFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { DeploymentEnvironment } from '../../shared/environment';

export interface FrontendChatProps {
  readonly environment: DeploymentEnvironment;
  readonly api: RestApi;
  readonly authorizer: RequestAuthorizer;
  readonly requestValidator: IRequestValidator;
  readonly orchestratorFunction: IFunction;
}

/** Owns authenticated streaming chat and its exact invocation permission in the consuming Frontend stack. */
export class FrontendChat extends Construct {
  public constructor(scope: Construct, id: string, props: FrontendChatProps) {
    super(scope, id);
    const apiRoot = props.api.root.getResource('api');
    if (!apiRoot) throw new Error('The frontend API root must exist before chat is attached.');
    const model = props.api.addModel('AuthenticatedChatRequestModel', {
      modelName: 'AuthenticatedChatRequest', contentType: 'application/json',
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
    const method = apiRoot.addResource('chat').addMethod('POST', new LambdaIntegration(props.orchestratorFunction, {
      proxy: true, allowTestInvoke: false, scopePermissionToMethod: true,
      responseTransferMode: ResponseTransferMode.STREAM, timeout: Duration.minutes(15),
    }), {
      authorizationType: AuthorizationType.CUSTOM, authorizer: props.authorizer,
      requestValidator: props.requestValidator, requestModels: { 'application/json': model },
    });
    const permissions = method.node.findAll().filter((node): node is CfnPermission => node instanceof CfnPermission);
    if (permissions.length !== 1) throw new Error('Expected one invocation permission for authenticated chat.');
    permissions[0].sourceAccount = Aws.ACCOUNT_ID;
    permissions[0].sourceArn = props.api.arnForExecuteApi('POST', '/api/chat', props.environment);
    Validations.of(method.node.defaultChild!).acknowledge({ id: 'AwsSolutions-COG4',
      reason: 'This exact method uses the existing zero-cache REQUEST authorizer to verify CloudFront origin, browser Origin and strongly consistent opaque-session/user records. A native JWT authorizer cannot validate the BFF cookie; only its validated Cognito sub enters chat ownership.' });
  }
}
