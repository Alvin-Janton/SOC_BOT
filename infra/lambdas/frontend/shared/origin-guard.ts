import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { timingSafeEqual } from 'node:crypto';

export const ORIGIN_HEADER = 'X-Soc-Bot-Origin';
const TOKEN_PATTERN = /^[A-Za-z0-9]{64}$/;
const CACHE_MS = 300_000;

/** Accepts JSON objects at the request boundary without trusting their fields. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Reads one header, reconciling equivalent single/multivalue maps while rejecting duplicates. */
function originHeader(event: Record<string, unknown>): string | undefined {
  const values: string[] = [];
  for (const name of ['headers', 'multiValueHeaders'] as const) {
    const raw = event[name];
    if (raw === undefined || raw === null) continue;
    const headers = record(raw);
    if (!headers) return undefined;
    const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === ORIGIN_HEADER.toLowerCase());
    if (matches.length > 1) return undefined;
    if (!matches.length) continue;
    const value = matches[0][1];
    if (name === 'multiValueHeaders') {
      if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') return undefined;
      values.push(value[0]);
    } else {
      if (typeof value !== 'string') return undefined;
      values.push(value);
    }
  }
  if (!values.length || values.some(value => !TOKEN_PATTERN.test(value) || value !== values[0])) return undefined;
  return values[0];
}

/** Verifies only AWSCURRENT, caching one validated token for at most five minutes and failing closed. */
export function createOriginGuard(secretArn: string): (event: Record<string, unknown>, remainingMs: number) => Promise<boolean> {

  const client = new SecretsManagerClient({
    maxAttempts: 2, requestHandler: { connectionTimeout: 500, requestTimeout: 2_000 },
  });

  let cache: { value: Buffer; expiresAt: number } | undefined;

  return async (event, remainingMs) => {
    const header = originHeader(event);

    if (!header || !Number.isFinite(remainingMs) || remainingMs <= 500) return false;

    try {
      if (!cache || cache.expiresAt <= Date.now()) {
        cache = undefined;
        const startedAt = Date.now();

        const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn, VersionStage: 'AWSCURRENT' }), {
          abortSignal: AbortSignal.timeout(Math.min(3_000, Math.floor(remainingMs - 500))),
        });

        if (typeof result.SecretString !== 'string' || !TOKEN_PATTERN.test(result.SecretString)
          || result.SecretBinary !== undefined || !result.VersionStages?.includes('AWSCURRENT')) return false;
        cache = { value: Buffer.from(result.SecretString, 'ascii'), expiresAt: startedAt + CACHE_MS };
      }

      return timingSafeEqual(Buffer.from(header, 'ascii'), cache.value);
    }

    catch {
      cache = undefined;
      return false;
    }
  };
}
