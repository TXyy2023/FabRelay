export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SCHEMA_ERROR'
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'AUTH_INTERACTION_REQUIRED'
  | 'GERBER_INVALID'
  | 'REQUIREMENT_CONFLICT'
  | 'PAGE_BUSINESS_ERROR'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALID'
  | 'APPROVAL_EXPIRED'
  | 'AMOUNT_EXCEEDED'
  | 'CONTRACT_DRIFT'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'BROWSER_UNAVAILABLE'
  | 'BROWSER_BUSY'
  | 'ORDER_UNKNOWN'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INTERNAL_ERROR';

export const EXIT_CODES: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 2,
  SCHEMA_ERROR: 2,
  AUTH_REQUIRED: 3,
  AUTH_EXPIRED: 3,
  AUTH_INTERACTION_REQUIRED: 3,
  GERBER_INVALID: 4,
  REQUIREMENT_CONFLICT: 4,
  PAGE_BUSINESS_ERROR: 5,
  APPROVAL_REQUIRED: 6,
  APPROVAL_INVALID: 6,
  APPROVAL_EXPIRED: 6,
  AMOUNT_EXCEEDED: 6,
  CONTRACT_DRIFT: 7,
  NETWORK_ERROR: 8,
  TIMEOUT: 8,
  BROWSER_UNAVAILABLE: 9,
  BROWSER_BUSY: 9,
  ORDER_UNKNOWN: 8,
  UNSUPPORTED_CAPABILITY: 5,
  INTERNAL_ERROR: 10
};

export class JlcError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'JlcError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function asJlcError(error: unknown): JlcError {
  if (error instanceof JlcError) return error;
  if (error instanceof Error) {
    return new JlcError('INTERNAL_ERROR', error.message, { cause: error });
  }
  return new JlcError('INTERNAL_ERROR', String(error));
}
