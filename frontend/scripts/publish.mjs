import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact frontend entries; keep aligned with PAGE_PATHS in src/routing.ts. There is no catch-all rewrite.
const HTML_ENTRIES = ['index.html', 'login', 'signup', 'confirm-signup', 'forgot-password', 'reset-password', 'account'];

/** Invokes the runner's AWS CLI with discrete arguments; no shell, discovery API, or credential output. */
function aws(...args) {
  return execFileSync('aws', [...args, '--region', 'us-east-1', '--no-cli-pager'], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Rejects unexpected build entries before any upload, including symlinks, dotfiles and source maps. */
function buildFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (name.startsWith('.') || name.endsWith('.map') || stat.isSymbolicLink()) throw new Error('Build contains an unsupported file.');
    if (stat.isDirectory()) return buildFiles(path);
    if (!stat.isFile()) throw new Error('Build contains an unsupported entry.');
    return [path];
  });
}

/** Publishes validated static output after stack deployment, retaining old hashes and copying entry HTML last. */
function publish() {
  const environment = process.env.DEPLOYMENT_ENVIRONMENT;
  const account = process.env.EXPECTED_ACCOUNT_ID;
  if (!['dev', 'demo'].includes(environment) || !/^\d{12}$/.test(account ?? '') || process.env.AWS_REGION !== 'us-east-1') {
    throw new Error('Expected a dev/demo environment, a twelve-digit account and us-east-1.');
  }
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const files = buildFiles(dist);
  const index = join(dist, 'index.html');
  const assets = join(dist, 'assets');
  if (!files.includes(index) || !lstatSync(index).size || !lstatSync(assets).isDirectory()
    || !files.some(path => path.startsWith(`${assets}/`) || path.startsWith(`${assets}\\`))
    || !files.some(path => path.endsWith('.js')) || !files.some(path => path.endsWith('.css'))) {
    throw new Error('Build the frontend first; index.html and fingerprinted assets are required.');
  }
  const stackName = `SOC-BOT-${environment.toUpperCase()}-FRONTEND`;
  const response = JSON.parse(aws('cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json'));
  const stack = response.Stacks?.[0];
  if (!Array.isArray(response.Stacks) || response.Stacks.length !== 1 || stack.StackName !== stackName
    || !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'].includes(stack.StackStatus)
    || typeof stack.StackId !== 'string' || !stack.StackId.startsWith(`arn:aws:cloudformation:us-east-1:${account}:stack/${stackName}/`)
    || !Array.isArray(stack.Outputs)) throw new Error('Frontend stack outputs are unavailable or do not match this deployment.');

  const output = key => {
    const entries = stack.Outputs.filter(entry => entry.OutputKey === key);
    if (entries.length !== 1 || typeof entries[0].OutputValue !== 'string' || !entries[0].OutputValue) {
      throw new Error(`Expected exactly one nonempty ${key} stack output.`);
    }
    return entries[0].OutputValue;
  };
  const bucket = output('FrontendBucketName');
  const distribution = output('DistributionId');
  if (bucket !== `soc-bot-${environment}-frontend-${account}-us-east-1` || !/^[A-Z0-9]{10,32}$/.test(distribution)) {
    throw new Error('Frontend bucket or distribution output failed environment validation.');
  }
  const revalidate = 'no-cache,max-age=0,must-revalidate';
  aws('s3', 'sync', assets, `s3://${bucket}/assets/`, '--cache-control', 'public,max-age=31536000,immutable', '--no-progress', '--only-show-errors');
  aws('s3', 'sync', dist, `s3://${bucket}/`, '--exclude', 'assets/*', ...HTML_ENTRIES.flatMap(entry => ['--exclude', entry]),
    '--cache-control', revalidate, '--no-progress', '--only-show-errors');
  for (const entry of HTML_ENTRIES) {
    aws('s3', 'cp', index, `s3://${bucket}/${entry}`, '--content-type', 'text/html', '--cache-control', revalidate, '--no-progress', '--only-show-errors');
  }
  // The literal wildcard is one argument, never expanded by a shell. Submission requires no polling permissions.
  const invalidation = JSON.parse(aws('cloudfront', 'create-invalidation', '--distribution-id', distribution, '--paths', '/*', '--output', 'json'));
  if (typeof invalidation.Invalidation?.Id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(invalidation.Invalidation.Id)) {
    throw new Error('Invalidation submission returned an unexpected response; inspect the deployment before retrying.');
  }
  console.info(`Published ${stackName}; CloudFront invalidation ${invalidation.Invalidation.Id} submitted. Completion is not polled.`);
}

try { publish(); }
catch (error) {
  // AWS CLI exceptions contain captured provider output; report only authored validation messages.
  console.error(error instanceof Error && !('status' in error) && !(error instanceof SyntaxError)
    ? error.message : 'Frontend publishing failed. Inspect the deployment and rerun; existing bucket contents were not deleted.');
  process.exitCode = 1;
}
