import { describe, expect, test } from 'bun:test';
import { TransportPool } from '../../src/transport/pool.ts';
import { handleHostCommand } from '../../src/proxy/router.ts';
import { parseHostCommand } from '../../src/proxy/protocol.ts';

function makeDeps() {
  let killed = false;
  const pool = new TransportPool();
  return {
    pool,
    onKill: () => {
      killed = true;
    },
    wasKilled: () => killed,
  };
}

describe('router — protocol responses', () => {
  test('host:version returns OKAY + 4-hex version', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(parseHostCommand('host:version'), deps);
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('OKAY');
    expect(reply.wire.subarray(4, 8).toString('ascii')).toBe('0004');
    const versionHex = reply.wire.subarray(8).toString('ascii');
    expect(versionHex).toMatch(/^[0-9a-f]{4}$/);
    // Default 41 → 0x0029
    expect(parseInt(versionHex, 16)).toBe(41);
  });

  test('host:devices returns OKAY + empty list when pool empty', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(parseHostCommand('host:devices'), deps);
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('OKAY');
    expect(reply.wire.subarray(4, 8).toString('ascii')).toBe('0000');
  });

  test('host:devices-l returns long format', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(parseHostCommand('host:devices-l'), deps);
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('OKAY');
  });

  test('host:track-devices replies with initial snapshot and stays open', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(parseHostCommand('host:track-devices'), deps);
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('OKAY');
    expect('closeAfter' in reply ? reply.closeAfter : false).toBeFalsy();
  });

  test('host:features returns OKAY + comma list', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(parseHostCommand('host:features'), deps);
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('OKAY');
    const len = parseInt(reply.wire.subarray(4, 8).toString('ascii'), 16);
    const body = reply.wire.subarray(8, 8 + len).toString('utf8');
    expect(body).toContain('shell_v2');
    expect(body).toContain('cmd');
  });

  test('host:host-features returns same as features', () => {
    const deps = makeDeps();
    const a = handleHostCommand(parseHostCommand('host:features'), deps);
    const b = handleHostCommand(parseHostCommand('host:host-features'), deps);
    expect(a.wire.toString('hex')).toBe(b.wire.toString('hex'));
  });

  test('host:kill triggers onKill and replies OKAY+closeAfter', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(parseHostCommand('host:kill'), deps);
    expect(deps.wasKilled()).toBe(true);
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('OKAY');
    expect('closeAfter' in reply ? reply.closeAfter : false).toBe(true);
  });

  test('host:list-forward returns empty when no forwards', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(parseHostCommand('host:list-forward'), deps);
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('OKAY');
    expect(reply.wire.subarray(4, 8).toString('ascii')).toBe('0000');
  });

  test('host:killforward and killforward-all OKAY', () => {
    const deps = makeDeps();
    const a = handleHostCommand(parseHostCommand('host:killforward:tcp:7100'), deps);
    expect(a.wire.toString('ascii').startsWith('OKAY')).toBe(true);
    const b = handleHostCommand(parseHostCommand('host:killforward-all'), deps);
    expect(b.wire.toString('ascii').startsWith('OKAY')).toBe(true);
  });

  test('host:forward FAILs when no devices online', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(
      parseHostCommand('host:forward:tcp:7100;tcp:7001'),
      deps,
    );
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('FAIL');
  });

  test('host:transport-any FAILs when no devices online', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(parseHostCommand('host:transport-any'), deps);
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('FAIL');
  });

  test('host:transport:unknown-serial FAILs', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(
      parseHostCommand('host:transport:emulator-5554'),
      deps,
    );
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('FAIL');
  });

  test('unknown command FAILs', () => {
    const deps = makeDeps();
    const reply = handleHostCommand(parseHostCommand('host:notreal'), deps);
    expect(reply.wire.subarray(0, 4).toString('ascii')).toBe('FAIL');
  });
});
