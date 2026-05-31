// ADBPD — UsbBridgeTransport.
//
// Thin wrapper over HybridBackendTransport that sets type='usb'. The
// constructor takes only what's known about a USB device at registration
// time (serial); the backend handles the rest via `--one-device <serial>`.

import { HybridBackendTransport } from './hybrid-backend.ts';
import type { HybridBackendOptions } from './hybrid-backend.ts';

export interface UsbTransportOptions extends Omit<HybridBackendOptions, 'type'> {
  /** Optional USB-specific metadata reported by the enumeration probe. */
  model?: string;
  manufacturer?: string;
  product?: string;
}

export class UsbBridgeTransport extends HybridBackendTransport {
  readonly model: string | undefined;
  readonly manufacturer: string | undefined;
  readonly product: string | undefined;

  constructor(opts: UsbTransportOptions) {
    super({ ...opts, type: 'usb' });
    this.model = opts.model;
    this.manufacturer = opts.manufacturer;
    this.product = opts.product;
  }
}
