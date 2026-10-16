import { randomUUID } from 'node:crypto';
import { InvocationContext, checkDeadline, configuration, invocationDeadline } from './config';
import { CatalogDocument, DocumentMetadata, RagError, RagRequest, RagResponse, boundedResponse, failure, parseRequest } from './contracts';
import { indexedDocument, indexedSections, loadIndex, retrieveSections } from './corpus';
import { PlaybookDocument } from './index-contract';

/** Selects catalog metadata explicitly, excluding internal S3 keys and all heading selectors. */
function catalogDocument(document: PlaybookDocument): CatalogDocument {
  return {
    document_id: document.document_id, title: document.title, version: document.version,
    incident_types: document.incident_types, keywords: document.keywords,
    retrieval_context: document.retrieval_context, section_count: document.sections.length,
  };
}

/** Includes source/authorship and explicit nullable licensing once per detailed response. */
function documentMetadata(document: PlaybookDocument): DocumentMetadata {
  return { ...catalogDocument(document), source: document.source, license: document.license };
}

/** Dispatches the approved operations without fetching Markdown for either metadata-only operation. */
async function dispatch(request: RagRequest, correlationId: string, deadline: number): Promise<RagResponse> {
  const config = configuration();
  const index = await loadIndex(config, deadline);
  checkDeadline(deadline);
  if (request.operation === 'describe_documents') {
    return { ok: true, operation: request.operation, correlation_id: correlationId,
      documents: index.documents.map(catalogDocument) };
  }
  const document = indexedDocument(index, request.document_id);
  const metadata = documentMetadata(document);
  if (request.operation === 'describe_document') {
    const sections = document.sections.map(section => ({
      section_id: section.section_id, title: section.title, summary: section.summary,
      incident_types: section.incident_types, indicators: section.indicators, keywords: section.keywords,
    }));
    return { ok: true, operation: request.operation, correlation_id: correlationId, document: metadata, sections };
  }
  const selected = indexedSections(document, request.section_ids);
  const sections = await retrieveSections(config, document, selected, deadline);
  return { ok: true, operation: request.operation, correlation_id: correlationId, document: metadata, sections };
}

/** Handles one private invocation with a complete bounded JSON result and one metadata-only outcome log. */
export async function handler(event: unknown, context: InvocationContext): Promise<RagResponse> {
  const started = Date.now();
  const correlationId = /^[a-zA-Z0-9-]{1,128}$/.test(context.awsRequestId) ? context.awsRequestId : randomUUID();
  let request: RagRequest | undefined;
  let response: RagResponse;
  try {
    request = parseRequest(event);
    const deadline = invocationDeadline(context);
    response = await dispatch(request, correlationId, deadline);
    checkDeadline(deadline);
    response = boundedResponse(response);
  } catch (error) {
    response = failure(error instanceof RagError ? error.code : 'INTERNAL_ERROR', request?.operation ?? null, correlationId);
  }
  // No event, document text, metadata bodies, SDK exceptions, or caller-supplied unvalidated IDs.
  console.info(JSON.stringify({
    event: 'rag_invocation', correlation_id: correlationId, operation: request?.operation ?? null,
    document_id: request && 'document_id' in request ? request.document_id : null,
    section_ids: request?.operation === 'retrieve_sections' ? request.section_ids : [],
    duration_ms: Date.now() - started, outcome: response.ok ? 'SUCCESS' : 'ERROR',
    error_code: response.ok ? null : response.error.code, response_bytes: Buffer.byteLength(JSON.stringify(response), 'utf8'),
    document_count: response.ok ? (response.operation === 'describe_documents' ? response.documents.length : 1) : 0,
    section_count: response.ok && 'sections' in response ? response.sections.length : 0,
  }));
  return response;
}
