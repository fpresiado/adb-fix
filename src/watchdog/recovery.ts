// ADBPD — auto-recovery for wedged devices.
//
// The cascade follows the blueprint Watchdog §7.1:
//   1. Reconnect immediately
//   2. If fail: wait 5s, retry
//   3. If fail: wait 15s, retry
//   4. If fail: wait 30s, retry (up to 3 retries)
//   5. If all fail: state → offline, alert FM.exe, await manual intervention

import { getLogger } from '../utils/logger.ts';
import type { DeviceTransport } from '../transport/base.ts';

const log = getLogger('recovery');

const DEFAULT_BACKOFFS_MS = [0, 5_000, 15_000, 30_000];

export interface RecoveryOptions {
  backoffsMs?: readonly number[];
}

export async function recoverTransport(
  t: DeviceTransport,
  opts: RecoveryOptions = {},
): Promise<{ success: boolean; attempts: number; durationMs: number }> {
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS;
  const start = Date.now();
  let attempts = 0;
  for (const delay of backoffs) {
    if (delay > 0) await sleep(delay);
    attempts++;
    log.info({ serial: t.serial, attempt: attempts }, 'recovery attempt');
    try {
      await t.reconnect();
      try {
        const rtt = await t.ping();
        log.info(
          { serial: t.serial, attempt: attempts, rtt },
          'recovery succeeded',
        );
        return { success: true, attempts, durationMs: Date.now() - start };
      } catch {
        // reconnect resolved but ping still fails; treat as failure.
      }
    } catch (err) {
      log.warn(
        {
          serial: t.serial,
          attempt: attempts,
          err: err instanceof Error ? err.message : String(err),
        },
        'recovery attempt failed',
      );
    }
  }
  return { success: false, attempts, durationMs: Date.now() - start };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
