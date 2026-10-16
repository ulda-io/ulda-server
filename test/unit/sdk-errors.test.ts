import { expect, it, vi } from "vitest";
import { DomainError, type ErrorCode } from "../../src/domain/errors.js";
import { sdkError, SdkLimitError } from "../../src/protocol/sdk-commands.js";

it.each([
  ["invalid_request", "invalid_request"], ["invalid_witness", "invalid_witness"],
  ["invalid_transition", "conflict"], ["witness_reuse_conflict", "conflict"],
  ["stale_state", "conflict"], ["not_found", "not_found"],
  ["rate_limited", "too_large"], ["not_ready", "not_ready"],
  ["invalid_proof", "invalid_proof"], ["internal_error", "storage_error"],
  ["unsupported_protocol_feature", "storage_error"],
])("maps %s to only the fixed wire code %s", (code, expected) => {
  const failure = new DomainError(code as ErrorCode, "synthetic private diagnostic", {
    cause: new Error("synthetic private cause"),
    current: { id: 1n, witness: Uint8Array.of(8), payload: Uint8Array.of(9) },
  });
  for (const key of ["message", "stack", "cause", "current", "toJSON"]) {
    Object.defineProperty(failure, key, { get() { throw new Error("must not inspect"); } });
  }
  expect(sdkError(failure)).toEqual({ ok: false, error: expected });
});

it.each(["constructor", "__proto__", "toString", "synthetic private code"])(
  "never exposes an unknown or inherited mapping for %s", code => {
    expect(sdkError(new DomainError(code as ErrorCode, "unused")))
      .toEqual({ ok: false, error: "storage_error" });
  },
);

it("does not invoke code getters or coercion hooks, and contains inspection failures", () => {
  const hook = vi.fn(() => { throw new Error("synthetic private failure"); });
  const getter = new DomainError("not_found", "unused");
  Object.defineProperty(getter, "code", { get: hook });
  const coercion = new DomainError("not_found", "unused");
  Object.defineProperty(coercion, "code", { value: { toString: hook } });
  const proxy = new Proxy({}, { getPrototypeOf: hook });
  for (const error of [getter, coercion, proxy, null, "private", new Error("private")]) {
    expect(sdkError(error)).toEqual({ ok: false, error: "storage_error" });
  }
  // instanceof can invoke a Proxy trap, but no accessor/coercion is needed.
  expect(hook).toHaveBeenCalledTimes(1);
  expect(sdkError(new SdkLimitError())).toEqual({ ok: false, error: "too_large" });
});
