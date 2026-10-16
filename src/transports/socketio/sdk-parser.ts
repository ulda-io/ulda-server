import { Encoder, Decoder as BaseDecoder, protocol, PacketType, type Packet } from "socket.io-parser";
import { SDK_LIMITS } from "../../protocol/sdk-commands.js";
import { IngressOwner, type IngressLease, type ServerAdmission } from "../../admission/server-admission.js";

export interface SdkDecoder extends BaseDecoder { bindAbort(abort: () => void): void }
export interface SdkParser { Encoder: typeof Encoder; Decoder: new () => SdkDecoder; protocol: typeof protocol }

/** Standard framing. A shared server budget is optional for client/test decoders. */
export function createSdkParser(admission?: ServerAdmission): SdkParser {
  class Decoder extends BaseDecoder {
    #receivedBytes = 0;
    #connectSeen = false;
    #current: IngressLease | undefined;
    #owner = admission ? new IngressOwner(admission) : undefined;
    #timer: NodeJS.Timeout | undefined;
    #abort: (() => void) | undefined;
    constructor() {
      super({ maxAttachments: SDK_LIMITS.batch * 2 });
      this.on("decoded", (packet: Packet) => {
        clearTimeout(this.#timer); this.#timer = undefined;
        this.#receivedBytes = 0;
        const lease = this.#current; this.#current = undefined;
        if (!lease || !admission) return;
        if (packet.nsp !== "/") { lease.release(); throw new Error("Unsupported namespace."); }
        if (packet.type === PacketType.EVENT || packet.type === PacketType.BINARY_EVENT) {
          admission.packets.set(packet.data as object, lease);
        } else {
          if (packet.type !== PacketType.CONNECT && packet.type !== PacketType.DISCONNECT) {
            lease.release(); throw new Error("Unsupported incoming packet.");
          }
          if (packet.type === PacketType.CONNECT) {
            if (this.#connectSeen) { lease.release(); throw new Error("Repeated CONNECT."); }
            this.#connectSeen = true;
            // No new wire fields: only normalize the internal absent auth value.
            packet.data ??= {};
            admission.handshakes.set(packet.data as object, this);
          }
          lease.release();
        }
      });
    }
    bindAbort(abort: () => void): void { this.#abort = abort; }
    override add(chunk: unknown): void {
      try {
        if (typeof chunk === "string") {
          if (this.#current) throw new Error("Incomplete binary packet.");
          const length = Buffer.byteLength(chunk);
          if (length > SDK_LIMITS.headerBytes) throw new Error("Header limit.");
          this.#receivedBytes = 0;
          if (this.#owner) {
            this.#current = this.#owner.begin();
            if (!this.#current.grow(length * 4)) throw new Error("Ingress capacity exceeded.");
            this.#timer = setTimeout(() => {
              this.destroy(); this.#abort?.();
            }, admission!.limits.binaryPacketTimeoutMs);
            this.#timer.unref();
          }
        } else {
          const length = chunk instanceof Uint8Array || chunk instanceof ArrayBuffer ? chunk.byteLength : -1;
          if (length < 0 || length > SDK_LIMITS.payloadBytes) throw new Error("Attachment limit.");
          this.#receivedBytes += length;
          if (this.#receivedBytes > SDK_LIMITS.messageBytes) throw new Error("Packet limit.");
          if (this.#owner && (!this.#current || !this.#current.grow(length + 64))) throw new Error("Ingress capacity exceeded.");
        }
        super.add(chunk);
      } catch (error) { this.destroy(); throw error; }
    }
    override destroy(): void {
      super.destroy(); clearTimeout(this.#timer); this.#timer = undefined;
      this.#current = undefined; this.#receivedBytes = 0; this.#owner?.destroy();
      // Claimed leases belong to accepted handlers and survive transport close.
    }
  }
  return { Encoder, Decoder, protocol };
}
export const sdkParser = createSdkParser();
