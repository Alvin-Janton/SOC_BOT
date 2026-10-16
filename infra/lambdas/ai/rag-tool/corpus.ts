import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { Configuration, MAX_INDEX_BYTES, MAX_MARKDOWN_BYTES, OBJECT_READ_TIMEOUT_MS, checkDeadline } from './config';
import { RagError } from './contracts';
import { PlaybookDocument, PlaybookIndex, PlaybookSection, parsePlaybookIndex } from './index-contract';
import { extractMarkdownSections, normalizeHeadingTitle } from './markdown-sections';

const s3 = new S3Client({ maxAttempts: 2 });

/** Converts service failures to safe codes without mistaking AccessDenied for proof of a missing key. */
function readFailure(error: unknown, aborted: boolean): RagError {
  if (error instanceof RagError) return error;
  const name = error instanceof Error ? error.name : '';
  if (aborted || ['AbortError', 'TimeoutError', 'RequestTimeout'].includes(name)) return new RagError('READ_TIMEOUT');
  const status = typeof error === 'object' && error !== null && '$metadata' in error
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if ((status !== undefined && (status >= 500 || status === 429))
    || ['SlowDown', 'Throttling', 'ThrottlingException', 'NetworkingError'].includes(name)
    || ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
      'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(String(code))) {
    return new RagError('READ_FAILED');
  }
  return new RagError('CORPUS_UNAVAILABLE');
}

/** Streams one approved object with metadata/actual-byte caps, strict UTF-8, and a bounded abort budget. */
async function readText(config: Configuration, key: string, maximum: number, deadline: number): Promise<string> {
  checkDeadline(deadline);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.min(OBJECT_READ_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
  timer.unref();
  let body: Readable | undefined;
  const stopBody = (): void => { body?.destroy(); };
  abort.signal.addEventListener('abort', stopBody, { once: true });
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: abort.signal });
    if (!(result.Body instanceof Readable)) throw new RagError('CORPUS_INVALID');
    body = result.Body;
    if (abort.signal.aborted) throw new RagError('READ_TIMEOUT');
    if (result.ContentLength !== undefined && (!Number.isSafeInteger(result.ContentLength)
      || result.ContentLength < 0 || result.ContentLength > maximum)) throw new RagError('CORPUS_INVALID');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of body) {
      if (abort.signal.aborted) throw new RagError('READ_TIMEOUT');
      if (!(chunk instanceof Uint8Array)) throw new RagError('CORPUS_INVALID');
      length += chunk.byteLength;
      if (length > maximum) throw new RagError('CORPUS_INVALID');
      chunks.push(chunk);
    }
    if (abort.signal.aborted) throw new RagError('READ_TIMEOUT');
    checkDeadline(deadline);
    try {
      // Preserve any BOM here; only the index JSON loader may strip its leading BOM.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length));
    } catch {
      throw new RagError('CORPUS_INVALID');
    }
  } catch (error) {
    throw readFailure(error, abort.signal.aborted);
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener('abort', stopBody);
    body?.destroy();
  }
}

/** Loads and validates the fixed index anew for this invocation, never listing or caching the corpus. */
export async function loadIndex(config: Configuration, deadline: number): Promise<PlaybookIndex> {
  const text = await readText(config, config.indexKey, MAX_INDEX_BYTES, deadline);
  try {
    return parsePlaybookIndex(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch {
    throw new RagError('CORPUS_INVALID');
  }
}

/** Resolves an ID only through the validated index, never by constructing a caller-selected path. */
export function indexedDocument(index: PlaybookIndex, id: string): PlaybookDocument {
  const document = index.documents.find(candidate => candidate.document_id === id);
  if (!document) throw new RagError('DOCUMENT_NOT_FOUND');
  return document;
}

/** Resolves the whole requested batch before any Markdown read and preserves its requested ordering. */
export function indexedSections(document: PlaybookDocument, ids: readonly string[]): PlaybookSection[] {
  return ids.map(id => {
    const section = document.sections.find(candidate => candidate.section_id === id);
    if (!section) throw new RagError('SECTION_NOT_FOUND');
    return section;
  });
}

/** Fetches/parses one Markdown object once, returning complete original excerpts or no guidance. */
export async function retrieveSections(config: Configuration, document: PlaybookDocument,
  sections: readonly PlaybookSection[], deadline: number): Promise<{ section_id: string; title: string; markdown: string }[]> {
  const text = await readText(config, document.s3_key, MAX_MARKDOWN_BYTES, deadline);
  try {
    const excerpts = extractMarkdownSections(text, sections.map(section => section.heading_path));
    const result = sections.map((section, position) => {
      const excerpt = excerpts[position];
      if (normalizeHeadingTitle(section.title) !== excerpt.headingPath[excerpt.headingPath.length - 1]) {
        throw new RagError('CORPUS_INVALID');
      }
      return { section_id: section.section_id, title: section.title, markdown: excerpt.markdown };
    });
    checkDeadline(deadline);
    return result;
  } catch (error) {
    if (error instanceof RagError) throw error;
    throw new RagError('CORPUS_INVALID');
  }
}
