import type {
  ProofVerificationInput,
  ProofVerifier,
} from "../domain/ports.js";

/**
 * Temporary protocol scaffold.
 *
 * This adapter deliberately performs no cryptographic verification. It keeps
 * the proof stage explicit and replaceable while the normative proof format
 * and its test vectors are still being designed.
 */
export class AllowAllProofVerifier implements ProofVerifier {
  async verify(_input: ProofVerificationInput): Promise<boolean> {
    return true;
  }
}
