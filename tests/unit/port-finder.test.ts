import { afterEach, describe, expect, test } from 'bun:test';
import * as net from 'node:net';
import { findFreePort } from '../../src/utils/port-finder.ts';

const servers: net.Server[] = [];
const cleanup = async (): Promise<void> => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers.length = 0;
};
afterEach(cleanup);

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      servers.push(s);
      resolve();
    });
  });
}

describe('findFreePort', () => {
  test('returns the start port if it is free', async () => {
    // Pick a likely-free high port.
    const port = await findFreePort(45000);
    expect(port).toBeGreaterThanOrEqual(45000);
  });

  test('skips an occupied port and returns the next free one', async () => {
    const occupied = 45100;
    await occupy(occupied);
    const port = await findFreePort(occupied);
    expect(port).toBeGreaterThan(occupied);
  });

  test('throws when no free port is available in range', async () => {
    // Edge case: search a range so narrow we KNOW it's covered.
    const base = 45200;
    await occupy(base);
    await expect(findFreePort(base, base)).rejects.toThrow();
  });
});
