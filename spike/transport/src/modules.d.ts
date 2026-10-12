// Minimal typings for the parts of the untyped Holepunch modules the spike uses.

declare module 'udx-native' {
  import type { Duplex } from 'node:stream';
  import type { EventEmitter } from 'node:events';

  export interface UDXSocket extends EventEmitter {
    bind(port?: number, host?: string): void;
    address(): { host: string; family: number; port: number };
    send(buf: Uint8Array, port: number, host?: string): Promise<boolean>;
    trySend(buf: Uint8Array, port: number, host?: string): void;
    close(): Promise<void>;
    setRecvBufferSize(n: number): number;
    setSendBufferSize(n: number): number;
  }

  export interface UDXStream extends Duplex {
    id: number;
    rtt: number;
    cwnd: number;
    mtu: number;
    connect(socket: UDXSocket, remoteId: number, port: number, host?: string): void;
  }

  export default class UDX {
    createSocket(opts?: { ipv6Only?: boolean }): UDXSocket;
    createStream(
      id: number,
      opts?: { firewall?: (socket: UDXSocket, port: number, host: string) => boolean },
    ): UDXStream;
  }
}

declare module '@hyperswarm/secret-stream' {
  import type { Duplex } from 'node:stream';

  export default class SecretStream extends Duplex {
    constructor(
      isInitiator: boolean,
      rawStream: Duplex,
      opts: { keyPair: { publicKey: Buffer; secretKey: Buffer } },
    );
    publicKey: Buffer;
    remotePublicKey: Buffer | null;
    handshakeHash: Buffer | null;
    setTimeout(ms: number): void;
  }
}
