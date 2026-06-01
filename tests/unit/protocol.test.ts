import { describe, expect, test } from 'bun:test';
import {
  encodeFail,
  encodeOkay,
  encodeOkayData,
  encodeMessage,
  parseHostCommand,
  tryParseRequest,
} from '../../src/proxy/protocol.ts';

describe('protocol — encode/parse', () => {
  test('encodeMessage produces 4-hex length + body', () => {
    const buf = encodeMessage('host:version');
    expect(buf.subarray(0, 4).toString('ascii')).toBe('000c'); // 12 chars
    expect(buf.subarray(4).toString('utf8')).toBe('host:version');
  });

  test('encodeOkay returns 4-byte OKAY', () => {
    const buf = encodeOkay();
    expect(buf.toString('ascii')).toBe('OKAY');
    expect(buf.length).toBe(4);
  });

  test('encodeOkayData prepends OKAY + length-prefixed payload', () => {
    const buf = encodeOkayData('0029');
    expect(buf.subarray(0, 4).toString('ascii')).toBe('OKAY');
    expect(buf.subarray(4, 8).toString('ascii')).toBe('0004');
    expect(buf.subarray(8).toString('utf8')).toBe('0029');
  });

  test('encodeFail prepends FAIL + length-prefixed message', () => {
    const buf = encodeFail('boom');
    expect(buf.subarray(0, 4).toString('ascii')).toBe('FAIL');
    expect(buf.subarray(4, 8).toString('ascii')).toBe('0004');
    expect(buf.subarray(8).toString('utf8')).toBe('boom');
  });

  test('tryParseRequest returns null on partial buffer', () => {
    expect(tryParseRequest(Buffer.from('00', 'ascii'))).toBeNull();
    expect(tryParseRequest(Buffer.from('000c', 'ascii'))).toBeNull();
  });

  test('tryParseRequest extracts payload and consumed length', () => {
    const input = Buffer.concat([encodeMessage('host:devices')]);
    const out = tryParseRequest(input);
    expect(out).not.toBeNull();
    expect(out?.payload).toBe('host:devices');
    expect(out?.consumed).toBe(input.length);
  });

  test('tryParseRequest throws on invalid hex length', () => {
    expect(() => tryParseRequest(Buffer.from('XXXXhost:version', 'ascii'))).toThrow();
  });
});

describe('protocol — parseHostCommand', () => {
  test('host:version', () => {
    expect(parseHostCommand('host:version')).toEqual({ kind: 'version' });
  });

  test('host:kill', () => {
    expect(parseHostCommand('host:kill')).toEqual({ kind: 'kill' });
  });

  test('host:devices and devices-l', () => {
    expect(parseHostCommand('host:devices')).toEqual({ kind: 'devices', long: false });
    expect(parseHostCommand('host:devices-l')).toEqual({ kind: 'devices', long: true });
  });

  test('host:track-devices', () => {
    expect(parseHostCommand('host:track-devices')).toEqual({ kind: 'track-devices' });
  });

  test('host:transport-any/usb/local', () => {
    expect(parseHostCommand('host:transport-any')).toEqual({
      kind: 'transport',
      selector: { mode: 'any' },
    });
    expect(parseHostCommand('host:transport-usb')).toEqual({
      kind: 'transport',
      selector: { mode: 'usb' },
    });
    expect(parseHostCommand('host:transport-local')).toEqual({
      kind: 'transport',
      selector: { mode: 'local' },
    });
  });

  test('host:transport:<serial>', () => {
    expect(parseHostCommand('host:transport:emulator-5554')).toEqual({
      kind: 'transport',
      selector: { mode: 'serial', serial: 'emulator-5554' },
    });
  });

  test('host:tport:any/usb/local/serial', () => {
    expect(parseHostCommand('host:tport:any')).toEqual({
      kind: 'transport',
      selector: { mode: 'any' },
    });
    expect(parseHostCommand('host:tport:serial:abc123')).toEqual({
      kind: 'transport',
      selector: { mode: 'serial', serial: 'abc123' },
    });
  });

  test('host:features and host:host-features', () => {
    expect(parseHostCommand('host:features')).toEqual({ kind: 'features' });
    expect(parseHostCommand('host:host-features')).toEqual({ kind: 'host-features' });
  });

  test('host:forward:tcp:7100;tcp:7001', () => {
    const cmd = parseHostCommand('host:forward:tcp:7100;tcp:7001');
    expect(cmd.kind).toBe('forward');
    if (cmd.kind === 'forward') {
      expect(cmd.spec).toBe('tcp:7100;tcp:7001');
      expect(cmd.norebind).toBe(false);
    }
  });

  test('host:forward:norebind:<spec>', () => {
    const cmd = parseHostCommand('host:forward:norebind:tcp:7100;tcp:7001');
    expect(cmd.kind).toBe('forward');
    if (cmd.kind === 'forward') {
      expect(cmd.spec).toBe('tcp:7100;tcp:7001');
      expect(cmd.norebind).toBe(true);
    }
  });

  test('host:killforward and host:killforward-all', () => {
    expect(parseHostCommand('host:killforward:tcp:7100')).toEqual({
      kind: 'killforward',
      local: 'tcp:7100',
    });
    expect(parseHostCommand('host:killforward-all')).toEqual({ kind: 'killforward-all' });
  });

  test('unknown command returns kind: unknown', () => {
    const cmd = parseHostCommand('host:not-a-real-thing');
    expect(cmd.kind).toBe('unknown');
  });

  test('non-host command also unknown', () => {
    expect(parseHostCommand('shell:echo hi').kind).toBe('unknown');
  });
});
