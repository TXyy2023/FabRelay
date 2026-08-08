import { randomUUID } from 'node:crypto';
import { asJlcError, EXIT_CODES } from '../domain/errors.js';
import { SCHEMA_VERSION, type CliErrorEnvelope, type CliMeta, type CliSuccessEnvelope } from '../domain/types.js';
import { redactSensitive } from '../logging/redact.js';

export interface OutputContext {
  json: boolean;
  requestId: string;
}

export function createOutputContext(json: boolean, requestId?: string): OutputContext {
  return { json, requestId: requestId || randomUUID() };
}

function meta(context: OutputContext): CliMeta {
  return { schemaVersion: SCHEMA_VERSION, requestId: context.requestId, environment: 'test' };
}

export function writeSuccess<T>(context: OutputContext, data: T): void {
  if (context.json) {
    const envelope: CliSuccessEnvelope<T> = { ok: true, data, meta: meta(context) };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`);
}

export function writeError(context: OutputContext, error: unknown): number {
  const value = asJlcError(error);
  if (context.json) {
    const envelope: CliErrorEnvelope = {
      ok: false,
      error: { code: value.code, message: value.message, retryable: value.retryable, details: redactSensitive(value.details) },
      meta: meta(context)
    };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else {
    process.stderr.write(`[${value.code}] ${value.message}\n`);
    if (value.details) process.stderr.write(`${JSON.stringify(redactSensitive(value.details), null, 2)}\n`);
  }
  return EXIT_CODES[value.code];
}
