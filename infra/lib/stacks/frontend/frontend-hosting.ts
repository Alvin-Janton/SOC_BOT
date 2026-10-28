import { Aws, RemovalPolicy, Validations } from 'aws-cdk-lib';
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
      ['CFR1', 'No geography-based access assumption is approved; this distribution exposes static content and generic health only.'],
      ['CFR3', 'CloudFront access logging is intentionally deferred pending storage/retention and privacy review; API metadata-only logs are enabled.'],
      ['CFR4', 'The generated hostname uses CloudFront\'s default certificate with its fixed TLSv1 security policy, not an enforced TLS 1.2 minimum. A custom domain/certificate is deferred and no auth/chat route is connected.'],
    ]) Validations.of(this.distribution.node.defaultChild!).acknowledge({ id: `AwsSolutions-${rule}`, reason });
    if (environment === 'demo') Validations.of(this.distribution.node.defaultChild!).acknowledge({
      id: 'AwsSolutions-CFR2',
      reason: 'Demo intentionally has no viewer WAF. Origin verification protects only frontend health; demo rollout and user authentication/abuse controls remain deferred.',
    });
  }
}
