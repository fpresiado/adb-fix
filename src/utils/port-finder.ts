// ADBPD — find free TCP ports for per-device backend adb servers.

import * as net from 'node:net';

const HOST = '127.0.0.1';

/**
 * Find a free TCP port at or after `start`. Returns the first port that
 * binds successfully (and is then immediately released).
 */
export async function findFreePort(start: number, max = start + 1000): Promise<number> {
  for (let port = start; port <= max; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port in [${start}, ${max}]`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, HOST);
  });
}
