import { record } from './origin-guard';
import { BffAuthError } from '../auth/errors';

/** Reconciles equivalent proxy-header maps, rejecting repeated or conflicting critical headers. */
export function header(event: Record<string, unknown>, name: string): string | undefined {
  const values: string[] = [];
  for (const mapName of ['headers', 'multiValueHeaders'] as const) {
    const raw = event[mapName];
    if (raw === null || raw === undefined) continue;
    const map = record(raw);
    if (!map) throw new BffAuthError('invalid_input');
    const entries = Object.entries(map).filter(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entries.length > 1) throw new BffAuthError('invalid_input');
    if (!entries.length) continue;
    const rawValue = entries[0][1];
    if (mapName === 'multiValueHeaders') {
      if (!Array.isArray(rawValue) || rawValue.length !== 1 || typeof rawValue[0] !== 'string') throw new BffAuthError('invalid_input');
      values.push(rawValue[0]);
    } else {
      if (typeof rawValue !== 'string') throw new BffAuthError('invalid_input');
      values.push(rawValue);
    }
  }
  if (values.some(value => [...value].some(character => (character.charCodeAt(0) < 32 && character !== '\t')
    || character.charCodeAt(0) === 127) || value !== values[0])) throw new BffAuthError('invalid_input');
  return values[0];
}

/** Enforces browser Origin and optional Fetch Metadata before either credential or session work. */
export function browserRequest(event: Record<string, unknown>, method: string, expectedOrigin: string): void {
  try {
    const origin = header(event, 'Origin');
    const site = header(event, 'Sec-Fetch-Site');

    if ((origin !== undefined && origin !== expectedOrigin) || (method === 'POST' && origin === undefined)
      || (site !== undefined && !['same-origin', 'same-site', 'none'].includes(site.toLowerCase()))) {
      throw new BffAuthError('invalid_origin');
    }
  } catch {
    throw new BffAuthError('invalid_origin');
  }
}
