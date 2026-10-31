import { Aws, Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import { RestApi } from 'aws-cdk-lib/aws-apigateway';
import { AllowedMethods, CachedMethods, CachePolicy, Distribution, OriginProtocolPolicy, OriginRequestPolicy,
  OriginSslPolicy, PriceClass, S3OriginAccessControl, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DeploymentEnvironment, frontendBucketName } from '../../shared/environment';
import { FrontendOriginAccess } from './frontend-origin-access';

export interface FrontendHostingProps {
  readonly environment: DeploymentEnvironment;
  readonly api: RestApi;
  readonly originAccess: FrontendOriginAccess;
  readonly webAclArn?: string;
}

/** Owns empty private hosting and one-way /api/* routing without a dependency on API deployment. */
export class FrontendHosting extends Construct {
  public readonly bucket: Bucket;
  public readonly distribution: Distribution;

  public constructor(scope: Construct, id: string, props: FrontendHostingProps) {
    super(scope, id);
    const { environment, api, originAccess } = props;
    this.bucket = new Bucket(this, 'Bucket', {
      bucketName: frontendBucketName(environment), blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED, enforceSSL: true,
      removalPolicy: environment === 'dev' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    const oac = new S3OriginAccessControl(this, 'OriginAccessControl', {
      originAccessControlName: `SOC-BOT-${environment.toUpperCase()}-FRONTEND-S3`,
    });
    this.distribution = new Distribution(this, 'Distribution', {
      comment: `SOC-BOT-${environment.toUpperCase()}-FRONTEND`, defaultRootObject: 'index.html',
      // The generated hostname uses CloudFront's fixed default-certificate security policy.
      priceClass: PriceClass.PRICE_CLASS_100,
      enableIpv6: environment !== 'dev', webAclId: props.webAclArn,
      // These supported CloudFront error statuses must not impose a cache floor on no-store API responses.
      errorResponses: [400, 403, 404, 405, 414, 500, 501, 502, 503, 504]
        .map(httpStatus => ({ httpStatus, ttl: Duration.seconds(0) })),
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket, { originAccessControl: oac }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD, cachedMethods: CachedMethods.CACHE_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new HttpOrigin(`${api.restApiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}`, {
            originPath: `/${environment}`, protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
            originSslProtocols: [OriginSslPolicy.TLS_V1_2],
            // Only this supported CloudFormation sink unwraps the token; synthesis retains a dynamic reference.
            customHeaders: { 'X-Soc-Bot-Origin': originAccess.secret.secretValue.unsafeUnwrap() },
          }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS, allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    Validations.of(this.bucket.node.defaultChild!).acknowledge({ id: 'AwsSolutions-S1',
      reason: 'Access-log storage/retention is deferred in this initial private frontend bucket; no application assets or user data are published by this slice.' });
    for (const [rule, reason] of [
      ['CFR1', 'No geography-based access assumption is approved; dev uses an explicit IPv4 viewer gate and auth routes independently enforce origin/session checks.'],
      ['CFR3', 'CloudFront access logging is intentionally deferred pending storage/retention and privacy review; API metadata-only logs are enabled.'],
      ['CFR4', 'The approved generated hostname retains CloudFront\'s default certificate and fixed TLSv1 viewer policy; TLS 1.2 minimum at the viewer requires a later custom domain/certificate. API-origin TLS 1.2, origin verification and secure-cookie session checks protect authenticated /api/chat.'],
    ]) Validations.of(this.distribution.node.defaultChild!).acknowledge({ id: `AwsSolutions-${rule}`, reason });
    if (environment === 'demo') Validations.of(this.distribution.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-CFR2',
      reason: 'Demo intentionally has no viewer WAF. Frontend health/auth enforce their origin/BFF rules and /api/chat requires a valid session at admission; public-demo rollout and abuse controls remain deferred. The separate legacy demo /chat endpoint remains unsafe for public release.',
    });
  }
}
