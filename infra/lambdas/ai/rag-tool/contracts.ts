import { z } from 'zod';
import { PlaybookDocument, PlaybookSection, playbookDocumentSchema, playbookIdSchema, playbookSectionSchema } from './index-contract';

export const MAX_REQUEST_BYTES = 4_096;
export const MAX_RESPONSE_BYTES = 32_768;

export const describeDocumentsRequestSchema = z.strictObject({ operation: z.literal('describe_documents') });
export const describeDocumentRequestSchema = z.strictObject({ operation: z.literal('describe_document'), document_id: playbookIdSchema });
export const retrieveSectionsRequestSchema = z.strictObject({
  operation: z.literal('retrieve_sections'), document_id: playbookIdSchema,
  section_ids: z.array(playbookIdSchema).min(1).max(3)
    .refine(ids => new Set(ids).size === ids.length, 'Section IDs must be distinct.'),
});
export const requestSchema = z.discriminatedUnion('operation', [
  describeDocumentsRequestSchema, describeDocumentRequestSchema, retrieveSectionsRequestSchema,
]);

export type RagRequest = z.infer<typeof requestSchema>;
export type RagOperation = RagRequest['operation'];
export type CatalogDocument = Pick<PlaybookDocument,
  'document_id' | 'title' | 'version' | 'incident_types' | 'keywords' | 'retrieval_context'> & { section_count: number };
export type DocumentMetadata = CatalogDocument & Pick<PlaybookDocument, 'source' | 'license'>;
export type SectionMetadata = Omit<PlaybookSection, 'heading_path'>;

export type RagResponse = { correlation_id: string } & (
  { ok: true; operation: 'describe_documents'; documents: CatalogDocument[] }
  | { ok: true; operation: 'describe_document'; document: DocumentMetadata; sections: SectionMetadata[] }
  | { ok: true; operation: 'retrieve_sections'; document: DocumentMetadata;
    sections: { section_id: string; title: string; markdown: string }[] }
  | { ok: false; operation: RagOperation | null; error: { code: ErrorCode; message: string; retryable: boolean } }
);

const FAILURES = {
  INVALID_INPUT: ['Expected a direct RAG request of at most 4096 UTF-8 bytes with approved fields and IDs.', false],
  DOCUMENT_NOT_FOUND: ['The document ID is not in the approved index.', false],
  SECTION_NOT_FOUND: ['One or more section IDs do not belong to the selected document; nothing was returned.', false],
  RESULT_TOO_LARGE: ['The complete result exceeds 32768 UTF-8 bytes. Request fewer sections; an oversized single section cannot be returned.', false],
  CONFIGURATION_ERROR: ['The RAG tool is not configured for an approved environment.', false],
  CORPUS_INVALID: ['The playbook corpus is invalid or exceeds its object limits; operator review is required.', false],
  CORPUS_UNAVAILABLE: ['The playbook corpus is unavailable; an authorized operator must check its objects and read permissions.', false],
  READ_TIMEOUT: ['The playbook read exceeded its time budget. Retry within the caller deadline.', true],
  READ_FAILED: ['A transient playbook read failure prevented completion.', true],
  INTERNAL_ERROR: ['The RAG tool could not safely complete the operation.', false],
} as const;
export type ErrorCode = keyof typeof FAILURES;

const catalogShape = {
  document_id: playbookDocumentSchema.shape.document_id,
  title: playbookDocumentSchema.shape.title,
  version: playbookDocumentSchema.shape.version,
  incident_types: playbookDocumentSchema.shape.incident_types,
  keywords: playbookDocumentSchema.shape.keywords,
  retrieval_context: playbookDocumentSchema.shape.retrieval_context,
  section_count: z.number().int().positive(),
};
const catalogSchema = z.strictObject(catalogShape);
const documentSchema = catalogSchema.extend({
  source: playbookDocumentSchema.shape.source, license: playbookDocumentSchema.shape.license,
});
const sectionSchema = playbookSectionSchema.omit({ heading_path: true });
const correlationSchema = z.string().regex(/^[a-zA-Z0-9-]{1,128}$/);
const errorCodes = Object.keys(FAILURES) as [ErrorCode, ...ErrorCode[]];

/** Validates the complete private wire response without importing a handler, S3 client, or corpus data. */
export const responseSchema = z.union([
  z.strictObject({ ok: z.literal(true), operation: z.literal('describe_documents'), correlation_id: correlationSchema,
    documents: z.array(catalogSchema).min(1) }),
  z.strictObject({ ok: z.literal(true), operation: z.literal('describe_document'), correlation_id: correlationSchema,
    document: documentSchema, sections: z.array(sectionSchema).min(1) }),
  z.strictObject({ ok: z.literal(true), operation: z.literal('retrieve_sections'), correlation_id: correlationSchema,
    document: documentSchema, sections: z.array(z.strictObject({ section_id: playbookIdSchema,
      title: playbookSectionSchema.shape.title, markdown: z.string().min(1).refine(value => /\S/u.test(value)) })).min(1).max(3) }),
  z.strictObject({ ok: z.literal(false), operation: z.enum(['describe_documents', 'describe_document', 'retrieve_sections']).nullable(),
    correlation_id: correlationSchema, error: z.strictObject({ code: z.enum(errorCodes), message: z.string().min(1).max(512),
      retryable: z.boolean() }) }).superRefine((response, context) => {
    const [message, retryable] = FAILURES[response.error.code];
    if (response.error.message !== message || response.error.retryable !== retryable) {
      context.addIssue({ code: 'custom', path: ['error'], message: 'Unexpected public error contract.' });
    }
  }),
]);

/** Carries only a fixed public error code; SDK and source diagnostics never become response text. */
export class RagError extends Error {
  public constructor(public readonly code: ErrorCode) {
    super(FAILURES[code][0]);
    this.name = 'RagError';
  }
}

/** Accepts only a bounded plain JSON event, not HTTP wrappers or arbitrary resource selectors. */
export function parseRequest(event: unknown): RagRequest {
  try {
    if (event === null || typeof event !== 'object' || Array.isArray(event)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(event))) throw new RagError('INVALID_INPUT');
    const serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) throw new RagError('INVALID_INPUT');
    const parsed = requestSchema.safeParse(event);
    if (!parsed.success) throw new RagError('INVALID_INPUT');
    return parsed.data;
  } catch {
    throw new RagError('INVALID_INPUT');
  }
}

/** Builds a bounded failure without echoing inputs, object keys, exception messages, or diagnostics. */
export function failure(code: ErrorCode, operation: RagOperation | null, correlationId: string): RagResponse {
  const [message, retryable] = FAILURES[code];
  return { ok: false, operation, correlation_id: correlationId, error: { code, message, retryable } };
}

/** Measures the whole envelope and replaces oversized successes with one small, complete error. */
export function boundedResponse(response: RagResponse): RagResponse {
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') <= MAX_RESPONSE_BYTES) return response;
  return failure('RESULT_TOO_LARGE', response.operation, response.correlation_id);
}
