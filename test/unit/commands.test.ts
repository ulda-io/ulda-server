import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors.js";
import {
  parseCreateCommand,
  parseDeleteCommand,
  parseReadManyCommand,
  parseSubscribeManyCommand,
  parseUpdateCommand,
} from "../../src/protocol/commands.js";

function updateEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    id: "42",
    baseWitness: Buffer.from([0, 1]).toString("base64url"),
    candidateWitness: Buffer.from([1, 2]).toString("base64url"),
    payload: Buffer.from("ciphertext").toString("base64url"),
    ...overrides,
  };
}

function deleteEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    id: "42",
    baseWitness: Buffer.from([0, 1]).toString("base64url"),
    candidateWitness: Buffer.from([1, 2]).toString("base64url"),
    ...overrides,
  };
}

describe("manual command validation", () => {
  it("accepts and deduplicates read-many ids in first-seen order", () => {
    expect(parseReadManyCommand({
      ids: ["2", "1", "2", "3", "1"],
    })).toEqual({ ids: [2n, 1n, 3n] });
  });

  it("accepts an empty read-many id list", () => {
    expect(parseReadManyCommand({ ids: [] })).toEqual({ ids: [] });
  });

  it.each([null, "1", 1, true, { id: "1" }])(
    "rejects non-array read-many ids %#",
    (ids) => {
      expect(() => parseReadManyCommand({ ids })).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
      );
    },
  );

  it.each([null, 1, true, {}, [], "01", "0", "-1", "1.0", "9223372036854775808"])(
    "rejects non-string or noncanonical read-many id %#",
    (id) => {
      expect(() => parseReadManyCommand({ ids: [id] })).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
      );
    },
  );

  it.each([
    { ids: ["1"], extra: true },
    { ids: ["1"], socketId: "spoof" },
    { ids: ["1"], action: "read" },
  ])("rejects unknown or connection-derived read-many fields", (value) => {
    expect(() => parseReadManyCommand(value)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
    );
  });

  it("accepts a resource list for subscribe-many", () => {
    expect(parseSubscribeManyCommand({
      resources: [{ id: "1" }, { id: "2" }],
    })).toEqual({ ids: [1n, 2n] });
  });

  it("deduplicates subscribe-many ids while preserving their first-seen order", () => {
    expect(parseSubscribeManyCommand({
      resources: [
        { id: "2" },
        { id: "1" },
        { id: "2" },
        { id: "3" },
        { id: "1" },
      ],
    })).toEqual({ ids: [2n, 1n, 3n] });
  });

  it("accepts an empty subscribe-many resource list", () => {
    expect(parseSubscribeManyCommand({ resources: [] })).toEqual({ ids: [] });
  });

  it.each([null, "resources", 1, true, { id: "1" }])(
    "rejects non-array subscribe-many resources %#",
    (resources) => {
      expect(() => parseSubscribeManyCommand({ resources })).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
      );
    },
  );

  it.each([null, "1", 1, true, []])(
    "rejects primitive or non-object subscribe-many item %#",
    (item) => {
      expect(() => parseSubscribeManyCommand({ resources: [item] })).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
      );
    },
  );

  it("rejects unknown fields in subscribe-many envelopes and items", () => {
    expect(() => parseSubscribeManyCommand({
      resources: [{ id: "1" }],
      extra: true,
    })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
    );
    expect(() => parseSubscribeManyCommand({
      resources: [{ id: "1", extra: true }],
    })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
    );
  });

  it.each([1, "01", "0", "-1", "1.0", "9223372036854775808"])(
    "rejects noncanonical subscribe-many id %#",
    (id) => {
      expect(() => parseSubscribeManyCommand({ resources: [{ id }] })).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
      );
    },
  );

  it.each([
    { resources: [{ id: "1" }], socketId: "spoof" },
    { resources: [{ id: "1" }], action: "subscribe" },
    { resources: [{ id: "1", socketId: "spoof" }] },
    { resources: [{ id: "1", action: "subscribe" }] },
  ])("rejects socket identity or action spoofing in subscribe-many", (value) => {
    expect(() => parseSubscribeManyCommand(value)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
    );
  });

  it("decodes canonical base64url and decimal fields", () => {
    const command = parseUpdateCommand(updateEnvelope());

    expect(command.id).toBe(42n);
    expect(command.payload).toEqual(new Uint8Array(Buffer.from("ciphertext")));
    expect(command.proof).toBeNull();
  });

  it("rejects the removed baseRevision field as unknown", () => {
    expect(() => parseUpdateCommand(updateEnvelope({ baseRevision: "0" }))).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
    );
    expect(() => parseDeleteCommand(deleteEnvelope({ baseRevision: "0" }))).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
    );
  });

  it("defaults missing update and delete proofs to null", () => {
    expect(parseUpdateCommand(updateEnvelope()).proof).toBeNull();
    expect(parseDeleteCommand(deleteEnvelope()).proof).toBeNull();
  });

  it("accepts an optional opaque proof object for update and delete", () => {
    const proof = { version: "stub", token: "opaque", nested: { value: 1 } };

    expect(parseUpdateCommand(updateEnvelope({ proof })).proof).toEqual(proof);
    expect(parseDeleteCommand(deleteEnvelope({ proof })).proof).toEqual(proof);
    expect(parseUpdateCommand(updateEnvelope({ proof: null })).proof).toBeNull();
    expect(parseDeleteCommand(deleteEnvelope({ proof: null })).proof).toBeNull();
  });

  it.each(["token", 1, true, [], ["token"]])(
    "rejects primitive or array proof value %#",
    (proof) => {
      expect(() => parseUpdateCommand(updateEnvelope({ proof }))).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
      );
      expect(() => parseDeleteCommand(deleteEnvelope({ proof }))).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
      );
    },
  );

  it("continues to reject proof on create", () => {
    expect(() =>
      parseCreateCommand({ witness: "AA", payload: "", proof: { token: "x" } }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({
      code: "invalid_request",
    }));
  });

  it.each([
    { id: 1, baseWitness: "AA", candidateWitness: "AQ", payload: "" },
    { id: "01", baseWitness: "AA", candidateWitness: "AQ", payload: "" },
    { id: "1", baseWitness: "AA==", candidateWitness: "AQ", payload: "" },
    { id: "1", baseWitness: "AA", candidateWitness: "AQ", payload: "", socketId: "spoof" },
  ])("rejects a non-canonical or untrusted envelope", (value) => {
    expect(() => parseUpdateCommand(value)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_request" }),
    );
  });
});
