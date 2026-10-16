import { DomainError, invalidRequest } from "../domain/errors.js";
import type { CreateStoredResource, StoredChange } from "../domain/ports.js";
import type { ActiveResource } from "../domain/resource.js";

export const SDK_LIMITS = Object.freeze({
  batch: 64, witnessBytes: 167, payloadBytes: 1_100_000,
  messageBytes: 8_388_608, headerBytes: 65_536,
});
export class SdkLimitError extends Error {}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw invalidRequest("Invalid command shape.");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw invalidRequest("Expected nonempty array.");
  if (value.length > SDK_LIMITS.batch) throw new SdkLimitError();
  return value;
}
export function sdkId(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) throw invalidRequest("Invalid ID.");
  const id = BigInt(value);
  if (id > 9_223_372_036_854_775_807n) throw invalidRequest("Invalid ID.");
  return id;
}
function unique(ids: bigint[]): bigint[] {
  if (new Set(ids).size !== ids.length) throw invalidRequest("Duplicate ID.");
  return ids;
}
export function parseSdkEmpty(value: unknown): void { exact(value, []); }
export function parseSdkRead(value: unknown): bigint[] { return unique(array(value).map(sdkId)); }
function bytes(value: unknown, limit: number, empty = false): Uint8Array {
  const data = value instanceof Uint8Array ? value
    : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  if (data === null || (!empty && data.byteLength === 0)) throw invalidRequest("Expected bytes.");
  if (data.byteLength > limit) throw new SdkLimitError();
  return data;
}
export function checkSdkSize(items: readonly { witness: Uint8Array; payload?: Uint8Array }[]): void {
  let size = 0;
  for (const item of items) {
    if (item.witness.byteLength > SDK_LIMITS.witnessBytes
      || (item.payload?.byteLength ?? 0) > SDK_LIMITS.payloadBytes) throw new SdkLimitError();
    size += item.witness.byteLength + (item.payload?.byteLength ?? 0);
    if (size > SDK_LIMITS.messageBytes) throw new SdkLimitError();
  }
}
function wireBytes(item: Record<string, unknown>, witnessLimit: number = SDK_LIMITS.witnessBytes): CreateStoredResource {
  return { witness: bytes(item.witness, Math.min(witnessLimit, SDK_LIMITS.witnessBytes)),
    payload: bytes(item.payload, SDK_LIMITS.payloadBytes, true) };
}
function cloneItems<T extends CreateStoredResource | StoredChange>(items: T[], reserveCopies?: (bytes: number) => void): T[] {
  // Validate aggregate/aliases BEFORE copying; repeated placeholders cannot amplify
  // a single attachment into an unaccounted oversized batch.
  const size = items.reduce((sum, item) => sum + item.witness.byteLength + (item.payload?.byteLength ?? 0), 0);
  reserveCopies?.(size * 3);
  return items.map(item => ({ ...item, witness: new Uint8Array(item.witness),
    ...(item.payload === undefined ? {} : { payload: new Uint8Array(item.payload) }) }));
}
export function parseSdkCreate(value: unknown, witnessLimit: number = SDK_LIMITS.witnessBytes, reserveCopies?: (bytes: number) => void): CreateStoredResource[] {
  const result = array(value).map(item => wireBytes(exact(item, ["witness", "payload"]), witnessLimit));
  checkSdkSize(result);
  return cloneItems(result, reserveCopies);
}
export function parseSdkChanges(value: unknown, deleting: boolean, witnessLimit: number = SDK_LIMITS.witnessBytes, reserveCopies?: (bytes: number) => void): StoredChange[] {
  const result: StoredChange[] = array(value).map(input => {
    const hasPayload = input !== null && typeof input === "object" && Object.hasOwn(input, "payload");
    const item = exact(input, deleting && !hasPayload ? ["id", "witness"] : ["id", "witness", "payload"]);
    return hasPayload ? { id: sdkId(item.id), ...wireBytes(item, witnessLimit) }
      : { id: sdkId(item.id), witness: bytes(item.witness, Math.min(witnessLimit, SDK_LIMITS.witnessBytes)) };
  });
  unique(result.map(item => item.id));
  if (deleting && !result.some(item => item.payload === undefined)) throw invalidRequest("Delete requires a deletion.");
  checkSdkSize(result);
  return cloneItems(result, reserveCopies);
}
export function sdkResource(resource: ActiveResource) {
  return { id: String(resource.id), witness: Buffer.from(resource.witness), payload: Buffer.from(resource.payload) };
}
const ERROR_CODES = new Map([
  ["invalid_request", "invalid_request"], ["invalid_witness", "invalid_witness"],
  ["invalid_transition", "conflict"], ["witness_reuse_conflict", "conflict"], ["stale_state", "conflict"],
  ["not_found", "not_found"], ["rate_limited", "too_large"], ["not_ready", "not_ready"],
  ["invalid_proof", "invalid_proof"],
]);
export function sdkError(error: unknown): { ok: false; error: string } {
  let code = "storage_error";
  try {
    if (error instanceof SdkLimitError) code = "too_large";
    else if (error instanceof DomainError) {
      // Never invoke accessors/coercion or reflect exception details onto the wire.
      const field = Object.getOwnPropertyDescriptor(error, "code");
      if (field && Object.hasOwn(field, "value") && typeof field.value === "string")
        code = ERROR_CODES.get(field.value) ?? code;
    }
  } catch { /* Even inspection of a thrown Proxy may fail. Use the fixed fallback. */ }
  return { ok: false, error: code };
}
