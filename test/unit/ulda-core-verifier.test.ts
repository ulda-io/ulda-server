import UldaCore from "ulda-core";
import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors.js";
import { UldaCoreVerifier } from "../../src/ulda/ulda-core-verifier.js";

interface TestUldaClient {
  New(index?: bigint): Uint8Array;
  stepUp(origin: Uint8Array): Uint8Array;
  sign(origin: Uint8Array): Promise<Uint8Array>;
}

const config = {
  N: 5,
  mode: "S" as const,
  hash: "SHA-256" as const,
  originSize: 256,
  pack: "compactV1" as const,
  ageBytes: 4 as const,
};

describe("UldaCoreVerifier", () => {
  it("uses ulda-core with directed previous-to-candidate verification", async () => {
    const client = new UldaCore({
      fmt: { export: "bytes" },
      sign: config,
    }) as unknown as TestUldaClient;
    const verifier = new UldaCoreVerifier(config);
    const origin0 = client.New();
    const witness0 = await client.sign(origin0);
    const witness1 = await client.sign(client.stepUp(origin0));

    await expect(verifier.verify(witness0, witness1)).resolves.toBe(true);
    await expect(verifier.verify(witness1, witness0)).resolves.toBe(false);
    await expect(verifier.verify(witness0, witness0)).resolves.toBe(false);
  });

  it("fails closed when a witness cannot be decoded", async () => {
    const verifier = new UldaCoreVerifier(config);

    await expect(
      verifier.verify(Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_witness" }),
    );
  });
});
