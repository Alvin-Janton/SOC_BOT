import { z } from 'zod';

/** Requires bounded metadata without silently trimming or replacing its content. */
function text(maximum: number) {
  return z.string().min(1).max(maximum).refine(value => /\S/u.test(value), 'Must not be blank.');
}

const slug = text(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Expected a lowercase hyphen-separated slug.');
const category = text(64).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, 'Expected a lowercase underscore-separated tag.');
const categories = z.array(category).min(1).refine(values => new Set(values).size === values.length, 'Duplicate tags.');
const keywords = z.array(text(80)).min(1).refine(values => new Set(values).size === values.length, 'Duplicate keywords.');

export const playbookSectionSchema = z.strictObject({
  section_id: slug,
  title: text(256),
  summary: text(600),
  heading_path: z.array(text(256)).min(1).max(5),
  incident_types: categories,
  indicators: z.array(category).refine(values => new Set(values).size === values.length, 'Duplicate indicators.'),
  keywords,
});

export const playbookDocumentSchema = z.strictObject({
  document_id: slug,
  title: text(256),
  version: text(32),
  s3_key: text(512).regex(
    /^playbooks\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    'Expected a relative playbooks/ Markdown key with safe path segments.',
  ),
  source: z.strictObject({
    type: z.enum(['project-authored', 'upstream', 'upstream-adapted']),
    author: text(128),
    reviewed_on: z.iso.date(),
    references: z.array(z.url({ protocol: /^https$/ })).min(1)
      .refine(values => new Set(values).size === values.length, 'Duplicate references.'),
  }),
  license: text(128).nullable(),
  incident_types: categories,
  keywords,
  retrieval_context: text(1_200),
  sections: z.array(playbookSectionSchema).min(1),
}).superRefine((document, context) => {
  const seen = new Set<string>();
  document.sections.forEach((section, position) => {
    if (seen.has(section.section_id)) {
      context.addIssue({ code: 'custom', path: ['sections', position, 'section_id'], message: 'Duplicate section ID within document.' });
    }
    seen.add(section.section_id);
  });
});

export const playbookIndexSchema = z.strictObject({
  schema_version: z.literal(1),
  documents: z.array(playbookDocumentSchema).min(1),
}).superRefine((index, context) => {
  const seen = new Set<string>();
  index.documents.forEach((document, position) => {
    if (seen.has(document.document_id)) {
      context.addIssue({ code: 'custom', path: ['documents', position, 'document_id'], message: 'Duplicate document ID.' });
    }
    seen.add(document.document_id);
  });
});

export type PlaybookIndex = z.infer<typeof playbookIndexSchema>;
export type PlaybookDocument = PlaybookIndex['documents'][number];
export type PlaybookSection = PlaybookDocument['sections'][number];

/** Validates only index data; importing this module never reads files or initializes AWS. */
export function parsePlaybookIndex(value: unknown): PlaybookIndex {
  return playbookIndexSchema.parse(value);
}
