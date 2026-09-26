// Read-only validation of synthesized policies; no AWS resources are changed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../cdk.out/CicdFoundationStack.template.json'), 'utf8'));
const refs = { 'AWS::Partition': 'aws', 'AWS::Region': 'us-east-1', 'AWS::AccountId': '111122223333' };
function resolve(value) {
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === 'object') {
    if (value.Ref) {
      if (!refs[value.Ref]) throw new Error(`Unknown reference ${value.Ref}`);
      return refs[value.Ref];
    }
    if (value['Fn::Join']) return resolve(value['Fn::Join'][1]).join(value['Fn::Join'][0]);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  }
  return value;
}
const policies = [];
for (const resource of Object.values(template.Resources)) {
  const props = resource.Properties;
  if (resource.Type === 'AWS::IAM::ManagedPolicy') {
    policies.push({ name: props.ManagedPolicyName, document: resolve(props.PolicyDocument), limit: 6144 });
  }
  if (resource.Type === 'AWS::IAM::Role') {
    if ((props.ManagedPolicyArns || []).length > 10) throw new Error('Attachment quota exceeded');
    let total = 0;
    for (const inline of props.Policies || []) {
      const document = resolve(inline.PolicyDocument);
      total += JSON.stringify(document).length;
      policies.push({ name: inline.PolicyName, document, limit: 10240 });
    }
    if (total > 10240) throw new Error('Inline aggregate quota exceeded');
  }
}
let failed = false;
for (const policy of policies) {
  const length = JSON.stringify(policy.document).length;
  console.log(`${policy.name}: ${length}/${policy.limit}`);
  if (length > policy.limit) failed = true;
  const environment = policy.name.includes('_DEV_') ? 'DEV' : 'DEMO';
  const other = environment === 'DEV' ? 'DEMO' : 'DEV';
  const serialized = JSON.stringify(policy.document);
  if (serialized.includes(`SOC_BOT_${other}_`) || serialized.includes(`SOC-BOT-${other}-`)
    || serialized.includes(`soc-bot-${other.toLowerCase()}-`)) throw new Error('Cross-environment resource');
  if (serialized.includes('_RUNTIME_BOUNDARY') || serialized.includes('cdk-hnb659fds-deploy-role')) throw new Error('Forbidden namespace');
  if (policy.name.includes('_BOUNDARY_') && serialized.includes('aws:PrincipalTag/')) throw new Error('Tag-selected boundary');
  for (const statement of policy.document.Statement) {
    const actions = [].concat(statement.Action);
    for (const action of actions) {
      if (action.startsWith('lakeformation:') && ![
        'lakeformation:RegisterResource', 'lakeformation:DeregisterResource', 'lakeformation:GrantPermissions',
        'lakeformation:RevokePermissions', 'lakeformation:ListPermissions', 'lakeformation:GetDataAccess',
      ].includes(action)) throw new Error(`Unapproved Lake Formation action ${action}`);
    }
    if (statement.Effect === 'Allow' && actions.some((a) => ['iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:SetDefaultPolicyVersion'].includes(a))) {
      if (![statement.Resource].flat().every((arn) => arn.endsWith(`SOC_BOT_${environment}_RUNTIME_POLICY_*`))) throw new Error('Unsafe managed-policy namespace');
    }
  }
}
if (process.argv.includes('--analyzer')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-bot-analyzer-'));
  let findings = 0;
  for (const policy of policies) {
    const file = path.join(directory, policy.name + '.json');
    fs.writeFileSync(file, JSON.stringify(policy.document));
    const response = JSON.parse(execFileSync('aws', ['accessanalyzer', 'validate-policy',
      '--region', 'us-east-1', '--policy-type', 'IDENTITY_POLICY', '--policy-document', `file://${file}`,
      '--output', 'json'], { encoding: 'utf8' }));
    for (const finding of response.findings) {
      findings++;
      console.log(policy.name, finding.findingType, finding.issueCode, finding.findingDetails);
      if (['ERROR', 'SECURITY_WARNING'].includes(finding.findingType)) failed = true;
    }
  }
  console.log(`Validated ${policies.length} synthesized policies; findings=${findings}. Resolved copies: ${directory}`);
}
if (failed) process.exitCode = 1;
