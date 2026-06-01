// ADBPD — EmulatorTransport.
//
// Thin wrapper over HybridBackendTransport that sets type='emulator'.
// All protocol/backend logic lives in the base.

import { HybridBackendTransport } from './hybrid-backend.ts';
import type { HybridBackendOptions } from './hybrid-backend.ts';

export interface EmulatorTransportOptions
  extends Omit<HybridBackendOptions, 'type'> {
  consolePort: number;
  adbPort: number;
}

export class EmulatorTransport extends HybridBackendTransport {
  readonly consolePort: number;
  readonly adbPort: number;

  constructor(opts: EmulatorTransportOptions) {
    super({ ...opts, type: 'emulator' });
    this.consolePort = opts.consolePort;
    this.adbPort = opts.adbPort;
  }
}

// Re-export public helpers used by tests.
export { SocketReader, writeAdbCommand } from './hybrid-backend.ts';
export type { SpawnedProcess } from './hybrid-backend.ts';
