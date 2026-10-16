declare module "ulda-core" {
  export interface UldaCoreConfig {
    version?: string;
    fmt?: { export?: "hex" | "base64" | "bytes" };
    sign?: {
      N?: number;
      mode?: "S" | "X";
      hash?: string;
      originSize?: number;
      pack?: "compactV1" | "simpleSig";
      ageBytes?: number;
    };
  }

  export default class UldaCore {
    constructor(config?: UldaCoreConfig);
    verify(
      previousWitness: Uint8Array,
      candidateWitness: Uint8Array,
    ): Promise<boolean>;
  }
}
