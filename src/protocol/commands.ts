import { invalidRequest } from "../domain/errors.js";
import type {
  CreateResourceCommand,
  DeleteResourceCommand,
  OpaqueProof,
  UpdateResourceCommand,
} from "../domain/resource.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("Command payload must be an object.");
  }
  return value as UnknownRecord;
}

function assertExactKeys(
  record: UnknownRecord,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  if (Object.hasOwn(record, "action") || Object.hasOwn(record, "socketId")) {
    throw invalidRequest("Action and socket identity are derived from the connection.");
  }

  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw invalidRequest(`Unknown command field: ${unknown[0]}`);
  }
  const missing = requiredKeys.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) {
    throw invalidRequest(`Missing command field: ${missing[0]}`);
  }
}

function parseUnsignedDecimal(value: unknown, field: string, minimum: bigint): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw invalidRequest(`${field} must be a canonical unsigned decimal string.`);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > 9_223_372_036_854_775_807n) {
    throw invalidRequest(`${field} is outside the signed 64-bit resource ID range.`);
  }
  return parsed;
}

function parseProof(value: unknown): OpaqueProof {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("proof must be an object or null.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseBase64Url(value: unknown, field: string, allowEmpty: boolean): Uint8Array {
  if (typeof value !== "string") {
    throw invalidRequest(`${field} must be an unpadded base64url string.`);
  }
  if ((!allowEmpty && value.length === 0) || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw invalidRequest(`${field} must be canonical unpadded base64url.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw invalidRequest(`${field} must be canonical unpadded base64url.`);
  }
  return new Uint8Array(decoded);
}

export function parseResourceIdCommand(value: unknown): { id: bigint } {
  const record = asRecord(value);
  assertExactKeys(record, ["id"]);
  return { id: parseUnsignedDecimal(record.id, "id", 1n) };
}

export function parseReadManyCommand(value: unknown): { ids: bigint[] } {
  const record = asRecord(value);
  assertExactKeys(record, ["ids"]);
  if (!Array.isArray(record.ids)) {
    throw invalidRequest("ids must be an array of resource ID strings.");
  }

  const ids: bigint[] = [];
  const seen = new Set<bigint>();
  for (const [index, value] of record.ids.entries()) {
    const id = parseUnsignedDecimal(value, `ids[${index}]`, 1n);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids };
}

export function parseSubscribeManyCommand(value: unknown): { ids: bigint[] } {
  const record = asRecord(value);
  assertExactKeys(record, ["resources"]);
  if (!Array.isArray(record.resources)) {
    throw invalidRequest("resources must be an array of { id } objects.");
  }

  const ids: bigint[] = [];
  const seen = new Set<bigint>();
  for (const [index, item] of record.resources.entries()) {
    const resource = asRecord(item);
    assertExactKeys(resource, ["id"]);
    const id = parseUnsignedDecimal(resource.id, `resources[${index}].id`, 1n);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids };
}

export function parseCreateCommand(value: unknown): CreateResourceCommand {
  const record = asRecord(value);
  assertExactKeys(record, ["witness", "payload"]);
  return {
    witness: parseBase64Url(record.witness, "witness", false),
    payload: parseBase64Url(record.payload, "payload", true),
  };
}

export function parseUpdateCommand(value: unknown): UpdateResourceCommand {
  const record = asRecord(value);
  assertExactKeys(
    record,
    ["id", "baseWitness", "candidateWitness", "payload"],
    ["proof"],
  );
  return {
    id: parseUnsignedDecimal(record.id, "id", 1n),
    baseWitness: parseBase64Url(record.baseWitness, "baseWitness", false),
    candidateWitness: parseBase64Url(
      record.candidateWitness,
      "candidateWitness",
      false,
    ),
    payload: parseBase64Url(record.payload, "payload", true),
    proof: parseProof(record.proof),
  };
}

export function parseDeleteCommand(value: unknown): DeleteResourceCommand {
  const record = asRecord(value);
  assertExactKeys(
    record,
    ["id", "baseWitness", "candidateWitness"],
    ["proof"],
  );
  return {
    id: parseUnsignedDecimal(record.id, "id", 1n),
    baseWitness: parseBase64Url(record.baseWitness, "baseWitness", false),
    candidateWitness: parseBase64Url(
      record.candidateWitness,
      "candidateWitness",
      false,
    ),
    proof: parseProof(record.proof),
  };
}
