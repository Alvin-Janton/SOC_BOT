import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { dataBucketName, DeploymentEnvironment } from '../../../lib/shared/environment';
import { environmentResources } from '../../../lib/stacks/cicd-foundation/policy-statements';
import { DataStack } from '../../../lib/stacks/data/data-stack';

const account = '111122223333';
const region = 'us-east-1';

function synthesize(environment: DeploymentEnvironment): { stack: DataStack; template: Template } {
  const app = new App();
  const stack = new DataStack(app, `${environment}DataStack`, {
    deploymentEnvironment: environment,
    stackName: `SOC-BOT-${environment.toUpperCase()}-DATA`,
    env: { account, region },
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('DataStack', () => {
  test.each(['dev', 'demo'] as const)('%s bucket matches the foundation name and security contract', (environment) => {
    const { stack, template } = synthesize(environment);
    expect(stack.stackName).toBe(`SOC-BOT-${environment.toUpperCase()}-DATA`);
    expect(environmentResources(environment).dataBucketName).toBe(dataBucketName(environment));
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: {
        'Fn::Join': ['', [
          `soc-bot-${environment}-data-`,
          { Ref: 'AWS::AccountId' },
          '-',
          { Ref: 'AWS::Region' },
        ]],
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      Tags: [
        { Key: 'Environment', Value: environment },
        { Key: 'ManagedBy', Value: 'CDK' },
        { Key: 'Project', Value: 'SOC_BOT' },
      ],
    });

    const buckets = template.findResources('AWS::S3::Bucket');
    const bucketLogicalId = Object.keys(buckets)[0];
    const bucket = Object.values(buckets)[0] as Record<string, any>;
    expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
    expect(bucket.Properties.LifecycleConfiguration).toBeUndefined();
    expect(bucket.Properties.LoggingConfiguration).toBeUndefined();
    expect(bucket.DeletionPolicy).toBe(environment === 'dev' ? 'Delete' : 'Retain');
    expect(bucket.UpdateReplacePolicy).toBe(environment === 'dev' ? 'Delete' : 'Retain');

    template.resourceCountIs('AWS::S3::BucketPolicy', 1);
    const policies = template.findResources('AWS::S3::BucketPolicy');
    const statements = (Object.values(policies)[0] as any).Properties.PolicyDocument.Statement;
    expect(statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Effect: 'Deny',
        Action: 's3:*',
        Principal: { AWS: '*' },
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        Resource: [
          { 'Fn::GetAtt': [bucketLogicalId, 'Arn'] },
          { 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketLogicalId, 'Arn'] }, '/*']] },
        ],
      }),
    ]));
  });
});
