import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { parsePlaybookIndex, PlaybookDocument, PlaybookSection } from '../lambdas/ai/rag-tool/index-contract';
import { extractMarkdownSections, MarkdownSection, normalizeHeadingTitle } from '../lambdas/ai/rag-tool/markdown-sections';

interface ReviewSection {
  readonly document: Omit<PlaybookDocument, 'sections'>;
  readonly section: PlaybookSection;
  readonly extracted: MarkdownSection;
  readonly utf8Bytes: number;
  readonly characters: number;
}

/** Checks resolved paths without confusing sibling prefixes with descendants. */
function within(directory: string, candidate: string): boolean {
  const suffix = relative(directory, candidate);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

/** Produces a diagnostic without requiring callers to assume thrown values are Errors. */
function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown validation failure.';
}

/** Resolves a validated key to a regular Markdown file without escaping playbooks via links. */
async function documentPath(repository: string, key: string): Promise<string> {
  const allowed = join(repository, 'playbooks');
  const root = await realpath(allowed);
  if (relative(allowed, root) !== '') throw new Error('The playbooks directory must not redirect to another location.');
  const candidate = await realpath(resolve(repository, key));
  if (!within(root, candidate) || relative(root, candidate) === '') throw new Error(`Playbook path escapes its directory: ${key}`);
  if (!(await lstat(candidate)).isFile()) throw new Error(`Playbook is not a regular file: ${key}`);
  return candidate;
}

/** Validates every indexed document before any preview filter or output write is applied. */
async function validateDocuments(repository: string, documents: readonly PlaybookDocument[]): Promise<ReviewSection[]> {
  const reviewed: ReviewSection[] = [];
  let failures = 0;
  for (const document of documents) {
    console.info(`Document ${document.document_id} v${document.version}: ${document.s3_key} (license: ${document.license ?? 'unspecified'})`);
    try {
      const markdown = await readFile(await documentPath(repository, document.s3_key), 'utf8');
      const { sections, ...metadata } = document;
      const extracted = extractMarkdownSections(markdown, sections.map(section => section.heading_path));
      sections.forEach((section, position) => {
        const selected = extracted[position];
        if (normalizeHeadingTitle(section.title) !== selected.headingPath[selected.headingPath.length - 1]) {
          throw new Error(`Section title does not match its resolved heading: ${section.section_id}`);
        }
        const utf8Bytes = Buffer.byteLength(selected.markdown, 'utf8');
        const characters = [...selected.markdown].length;
        console.info(`  ${section.section_id}: ${JSON.stringify(selected.headingPath)} | lines ${selected.startLine}-${selected.endLine} | ${utf8Bytes} UTF-8 bytes, ${characters} characters`);
        reviewed.push({ document: metadata, section, extracted: selected, utf8Bytes, characters });
      });
    } catch (error) {
      failures += 1;
      console.error(`ERROR ${document.document_id}: ${diagnostic(error)}`);
    }
  }
  if (failures) throw new Error(`Validation failed for ${failures} document(s); no previews written.`);
  return reviewed;
}

/** Checks the nearest existing ancestor before creating an ignored preview directory. */
async function previewDirectory(repository: string, requested: string): Promise<string> {
  const allowed = join(repository, 'artifacts');
  const target = resolve(repository, requested);
  if (!within(allowed, target)) throw new Error('Preview directory must be under the repository artifacts/ directory.');
  let ancestor = target;
  let physical: string;
  for (;;) {
    try { physical = await realpath(ancestor); break; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (!within(allowed, resolve(physical, relative(ancestor, target)))) throw new Error('Preview directory escapes artifacts/ through a symbolic link.');
  await mkdir(target, { recursive: true });
  const directory = await realpath(target);
  if (!within(allowed, directory)) throw new Error('Resolved preview directory escapes artifacts/.');
  return directory;
}

/** Writes complete offline review envelopes; never clears existing directories or follows output links. */
async function writePreviews(repository: string, requested: string, indexPath: string, sections: readonly ReviewSection[]): Promise<void> {
  const directory = await previewDirectory(repository, requested);
  const index = await realpath(indexPath);
  const files = sections.map(section => ({
    section, path: join(directory, `${section.document.document_id}--${section.section.section_id}.json`),
  }));
  for (const file of files) {
    try {
      const existing = await lstat(file.path);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Preview target is not a regular file: ${file.path}`);
      if (relative(index, await realpath(file.path)) === '') throw new Error('Preview would overwrite the input index.');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  for (const file of files) {
    const { document, section, extracted, utf8Bytes, characters } = file.section;
    const envelope = {
      preview_schema_version: 1,
      ...document,
      section: { ...section, heading_path: extracted.headingPath },
      source_position: { heading_level: extracted.headingLevel, start_line: extracted.startLine, end_line: extracted.endLine },
      size: { utf8_bytes: utf8Bytes, characters },
      markdown: extracted.markdown,
    };
    await writeFile(file.path, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  }
  console.info(`Wrote ${files.length} review preview(s) to ${relative(repository, directory)}. Existing unrelated files were not removed.`);
}

/** Runs the local-only index validator without loading CDK, AWS clients, or runtime handlers. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      index: { type: 'string', default: 'playbooks/index.json' },
      'document-id': { type: 'string' },
      'preview-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true, allowPositionals: false,
  });
  if (values.help) {
    console.info('Usage: npm run playbooks:validate -- [--index playbooks/index.json] [--document-id ID] [--preview-dir artifacts/playbook-index-preview]');
    return;
  }
  // The root command builds this file to infra/dist/bin/ before executing it.
  const repository = await realpath(resolve(__dirname, '../../..'));
  const indexPath = resolve(repository, values.index ?? 'playbooks/index.json');
  const index = parsePlaybookIndex(JSON.parse((await readFile(indexPath, 'utf8')).replace(/^\uFEFF/, '')));
  const reviewed = await validateDocuments(repository, index.documents);
  if (values['document-id'] !== undefined && !index.documents.some(document => document.document_id === values['document-id'])) {
    throw new Error(`Unknown document ID: ${values['document-id']}`);
  }
  console.info(`Validated ${index.documents.length} document(s), ${reviewed.length} section(s). Section sizes are informational; nothing was truncated.`);
  if (values['preview-dir'] !== undefined) {
    const selected = reviewed.filter(section => values['document-id'] === undefined || section.document.document_id === values['document-id']);
    await writePreviews(repository, values['preview-dir'], indexPath, selected);
  }
}

if (require.main === module) {
  void main().catch(error => {
    console.error(`ERROR: ${diagnostic(error)}`);
    process.exitCode = 1;
  });
}
