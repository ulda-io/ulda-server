import UldaCore from "ulda-core";

import { DomainError } from "../domain/errors.js";
import type { UldaVerifier } from "../domain/ports.js";

export interface UldaCoreVerifierConfig {
  originSize: number;
  pack: "compactV1";
}

export class UldaCoreVerifier implements UldaVerifier {
  readonly #core: UldaCore;

  constructor(config: UldaCoreVerifierConfig) {
    this.#core = new UldaCore({
      version: "1",
      fmt: { export: "bytes" },
      sign: {
        originSize: config.originSize,
        pack: config.pack,
      },
    });
  }

  async verify(
    previousWitness: Uint8Array,
    candidateWitness: Uint8Array,
  ): Promise<boolean> {
    try {
      return await this.#core.verify(previousWitness, candidateWitness);
    } catch (error) {
      throw new DomainError(
        "invalid_witness",
        "Current or candidate witness could not be decoded or verified.",
        { cause: error },
      );
    }
  }
}
