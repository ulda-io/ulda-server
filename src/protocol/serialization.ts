import { DomainError } from "../domain/errors.js";
import type {
  ActiveResource,
  DeletedResource,
} from "../domain/resource.js";

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function serializeActiveResource(resource: ActiveResource) {
  return {
    id: resource.id.toString(),
    witness: encodeBytes(resource.witness),
    payload: encodeBytes(resource.payload),
  };
}

export function serializeDeletedResource(resource: DeletedResource) {
  return {
    id: resource.id.toString(),
    witness: encodeBytes(resource.witness),
  };
}

export function serializeResource(resource: ActiveResource) {
  return serializeActiveResource(resource);
}

export function serializeFailure(error: unknown, requestId: string) {
  if (error instanceof DomainError) {
    return {
      ok: false as const,
      error: {
        code: error.code,
        message: error.message,
        requestId,
      },
      ...(error.current === undefined
        ? {}
        : { current: serializeActiveResource(error.current) }),
    };
  }

  return {
    ok: false as const,
    error: {
      code: "internal_error" as const,
      message: "Internal server error.",
      requestId,
    },
  };
}
