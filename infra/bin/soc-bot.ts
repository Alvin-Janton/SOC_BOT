#!/usr/bin/env node
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CicdFoundationStack } from '../lib/cicd-foundation-stack';

const app = new App();

new CicdFoundationStack(app, 'CicdFoundationStack', {
  stackName: 'SOC-BOT-CICD-FOUNDATION',
  env: {
    region: 'us-east-1',
  },
  description: 'Account-level GitHub OIDC and CI/CD IAM foundation for SOC Bot',
});

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

app.synth();
