import { diagnosticFailure, FailureCode, ParserDiagnostics } from './parser-diagnostics';
import { ChatError } from './config';
import type { JsonValue } from './store';

/** Produces a content-free parser/storage validation failure. */
export function protocolError(code: FailureCode = 'UNCLASSIFIED_PROTOCOL_ERROR', diagnostics?: ParserDiagnostics): ChatError {
  return diagnosticFailure(new ChatError('MODEL_PROTOCOL_ERROR', 'The model response could not be processed safely.'), code, diagnostics);
}

/** Accepts lossless finite JSON only, without coercing null, scalar or array tool inputs into objects. */
export function jsonValue(value: unknown, depth = 0, diagnostics?: ParserDiagnostics): asserts value is JsonValue {
  if (depth > 24) throw protocolError('JSON_DEPTH_INVALID', diagnostics);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw protocolError('JSON_STRING_INVALID', diagnostics);
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length
      || Object.getOwnPropertyNames(value).length !== value.length + 1) throw protocolError('JSON_ARRAY_SHAPE_INVALID', diagnostics);
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw protocolError('JSON_ARRAY_DESCRIPTOR_INVALID', diagnostics);
      jsonValue(descriptor.value, depth + 1, diagnostics);
    }
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (Object.getOwnPropertySymbols(value).length) throw protocolError('JSON_OBJECT_SYMBOLS_INVALID', diagnostics);
    Object.entries(Object.getOwnPropertyDescriptors(value)).forEach(([key, descriptor]) => {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw protocolError('JSON_OBJECT_DESCRIPTOR_INVALID', diagnostics);
      jsonValue(key, depth + 1, diagnostics); jsonValue(descriptor.value, depth + 1, diagnostics);
    }); return;
  }
  throw protocolError('JSON_TYPE_INVALID', diagnostics);
}

/** Measures JSON using SDK-equivalent base64 for binary fields rather than Uint8Array's numeric JSON keys. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, item: unknown) => ArrayBuffer.isView(item) && Object.prototype.toString.call(item) === '[object Uint8Array]'
    ? Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('base64') : item), 'utf8');
}
