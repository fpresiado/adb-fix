// ADBPD — FM.exe HMAC-signed HTTP client.
//
// Mirrors a canonical HMAC signing pattern from a separate internal
// project, byte-for-byte:
//
//   bodyHash  = sha256(JSON.stringify(body) || '').hex  (lowercase)
//   message   = `${installId}:${unixSeconds}:${bodyHash}`
//   signature = hmac_sha256(token, message).hex          (lowercase)
//
// Headers sent on every request:
//   X-Install-Id:    <installId>
//   X-App-Token:     <token>
//   X-FM-Timestamp:  <unix-seconds as string>
//   X-FM-Signature:  <lowercase hex>
//   X-Customer-Id:   <customerId>   (only when present)
//   Content-Type:    application/json
//
// Per the spec, ADBPD ships with `fm.enabled: false`. The client is wired up
// but not invoked until the flag flips. Events queue to SQLite in the
// meantime; bridge replays on enable.

import { createHash, createHmac } from 'node:crypto';
import { getLogger } from '../utils/logger.ts';

const log = getLogger('fm-client');

export interface FmConfig {
  enabled: boolean;
  url: string;
  installId: string;
  token: string;
  customerId?: string;
}

export interface FmRequest<T = unknown> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: T;
}

export interface FmResponse<T = unknown> {
  status: number;
  data: T | undefined;
  raw: string;
}

export function computeSignature(
  token: string,
  installId: string,
  unixSeconds: number,
  body: string,
): string {
  const bodyHash = createHash('sha256').update(body || '').digest('hex');
  return createHmac('sha256', token)
    .update(`${installId}:${unixSeconds}:${bodyHash}`)
    .digest('hex');
}

export class FmClient {
  private cfg: FmConfig;

  constructor(cfg: FmConfig) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  get url(): string {
    return this.cfg.url;
  }

  get installId(): string {
    return this.cfg.installId;
  }

  setEnabled(enabled: boolean): void {
    this.cfg = { ...this.cfg, enabled };
  }

  async request<T = unknown>(req: FmRequest): Promise<FmResponse<T>> {
    if (!this.cfg.enabled) {
      throw new Error('FmClient.request called while disabled');
    }
    const bodyStr = req.body === undefined ? '' : JSON.stringify(req.body);
    const unixSeconds = Math.floor(Date.now() / 1000);
    const signature = computeSignature(
      this.cfg.token,
      this.cfg.installId,
      unixSeconds,
      bodyStr,
    );

    const url = this.cfg.url.replace(/\/+$/, '') + req.path;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Install-Id': this.cfg.installId,
      'X-App-Token': this.cfg.token,
      'X-FM-Timestamp': String(unixSeconds),
      'X-FM-Signature': signature,
    };
    if (this.cfg.customerId !== undefined) {
      headers['X-Customer-Id'] = this.cfg.customerId;
    }

    log.debug({ url, method: req.method, hasBody: bodyStr.length > 0 }, 'fm request');
    const resp = await fetch(url, {
      method: req.method,
      headers,
      body: bodyStr === '' ? undefined : bodyStr,
    });
    const raw = await resp.text();
    let data: T | undefined;
    if (raw.length > 0) {
      try {
        data = JSON.parse(raw) as T;
      } catch {
        data = undefined;
      }
    }
    return { status: resp.status, data, raw };
  }
}
