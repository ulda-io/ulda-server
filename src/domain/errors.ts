import type { ActiveResource } from "./resource.js";

export type ErrorCode =
  | "invalid_request"
  | "invalid_witness"
  | "invalid_proof"
  | "not_found"
  | "stale_state"
  | "witness_reuse_conflict"
  | "unsupported_protocol_feature"
  | "invalid_transition"
  | "rate_limited"
  | "internal_error"
  | "not_ready";

interface DomainErrorDetails {
  current?: ActiveResource;
  cause?: unknown;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly current?: ActiveResource;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, details: DomainErrorDetails = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    if (details.current !== undefined) this.current = details.current;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

export function invalidRequest(message: string, cause?: unknown): DomainError {
  return new DomainError("invalid_request", message, cause === undefined ? {} : { cause });
}
