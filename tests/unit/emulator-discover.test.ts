import { afterEach, describe, expect, test } from 'bun:test';
import * as net from 'node:net';
import { discoverEmulators } from '../../src/emulator/discover.ts';

const servers: net.Server[] = [];

function listen(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((sock) => sock.destroy());
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      servers.push(s);
      resolve();
    });
  });
}

afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers.length = 0;
});

describe('discoverEmulators', () => {
  test('returns empty when no ports are open in the emulator range', async () => {
    const found = await discoverEmulators();
    // Cannot guarantee no real emulators on host; assert structurally.
    for (const e of found) {
      expect(e.adbPort).toBeGreaterThanOrEqual(5555);
      expect(e.adbPort).toBeLessThanOrEqual(5585);
      expect(e.consolePort).toBe(e.adbPort - 1);
      expect(e.serial).toBe(`emulator-${e.consolePort}`);
    }
  });

  test('detects a fake emulator on 5557 if we open one', async () => {
    // Find a free port in the 5555..5585 range (skip 5555 if real emulator).
    let target: number | undefined;
    for (const p of [5559, 5561, 5563, 5565, 5567, 5557, 5571, 5573, 5575]) {
      try {
        await listen(p);
        target = p;
        break;
      } catch {
        /* port busy, try next */
      }
    }
    if (target === undefined) {
      // Whole range was busy — skip rather than fail flakily.
      return;
    }
    const found = await discoverEmulators();
    expect(found.some((e) => e.adbPort === target)).toBe(true);
  });
});
