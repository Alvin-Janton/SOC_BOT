import contract from './tool-validation-contract.json';

export type ValidationStage = keyof typeof contract.stages;
export type ValidationSeed = { readonly path: readonly PropertyKey[]; readonly code: string };
export type ToolValidation = {
  stage: ValidationStage;
  issues: { path: (string | number)[]; code: string; message: string }[];
  omitted?: true;
};

/** Recognizes only ordinary JSON maps before inspecting diagnostic fields. */
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

/** Accepts only schema-owned parameter paths and bounded indices, never caller-authored keys. */
function safePath(value: unknown): value is (string | number)[] {
  return Array.isArray(value) && contract.path_shapes.some(shape => shape.length === value.length
    && shape.every((segment, index) => segment === '#'
      ? typeof value[index] === 'number' && Number.isInteger(value[index]) && value[index] >= 0 && value[index] <= contract.max_index
      : segment === value[index]));
}

/** Enforces the same exact, content-free metadata contract at storage, recovery and logging boundaries. */
export function validToolValidation(value: unknown): value is ToolValidation {
  if (!record(value) || !Object.hasOwn(value, 'stage') || !Object.hasOwn(value, 'issues')
    || Object.keys(value).some(key => !['stage', 'issues', 'omitted'].includes(key))
    || (Object.hasOwn(value, 'omitted') && value.omitted !== true)
    || typeof value.stage !== 'string' || !Object.hasOwn(contract.stages, value.stage)
    || !Array.isArray(value.issues) || value.issues.length < 1 || value.issues.length > contract.max_issues) return false;
  const messages: Readonly<Record<string, string>> = contract.stages[value.stage as ValidationStage];
  if (!Array.from(value.issues).every(issue => record(issue) && Object.keys(issue).length === 3 && Object.hasOwn(issue, 'path')
    && Object.hasOwn(issue, 'code') && Object.hasOwn(issue, 'message') && safePath(issue.path)
    && typeof issue.code === 'string' && Object.hasOwn(messages, issue.code) && issue.message === messages[issue.code])) return false;
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= contract.max_bytes;
}

/** Copies only approved locations/codes into authored messages; omissions never echo rejected content. */
export function toolValidation(stage: ValidationStage, seeds: readonly ValidationSeed[] = []): ToolValidation {
  const messages: Readonly<Record<string, string>> = contract.stages[stage];
  const issues: ToolValidation['issues'] = [];
  let omitted = seeds.length > contract.max_issues;
  for (const seed of seeds.slice(0, contract.max_issues)) {
    const path = safePath(seed.path) ? [...seed.path] as (string | number)[] : [];
    const code = Object.hasOwn(messages, seed.code) ? seed.code : 'GENERIC';
    if (!safePath(seed.path) || code !== seed.code) omitted = true;
    issues.push({ path, code, message: messages[code] });
  }
  if (!issues.length) issues.push({ path: [], code: 'GENERIC', message: messages.GENERIC });
  const result: ToolValidation = { stage, issues, ...(omitted ? { omitted: true } : {}) };
  return validToolValidation(result) ? result
    : { stage, issues: [{ path: [], code: 'GENERIC', message: messages.GENERIC }], omitted: true };
}
