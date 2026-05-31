// Tests for SocketReader — uses Node's `stream.PassThrough` to avoid the
// Bun bun:test + net.Server segfault pattern. The reader treats any Readable
// the same as a net.Socket for our purposes.

import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { SocketReader } from '../../src/transport/emulator.ts';

function makeReader(): { stream: PassThrough; reader: SocketReader } {
  const stream = new PassThrough();
  // The SocketReader constructor signature is (sock: net.Socket) but the only
  // methods it calls are .on('data'/'end'/'error'). PassThrough provides all.
  const reader = new SocketReader(stream as unknown as import('node:net').Socket);
  return { stream, reader };
}

describe('SocketReader', () => {
  test('readExact returns the requested bytes when data is already buffered', async () => {
    const { stream, reader } = makeReader();
    stream.write('ABCDEF');
    const buf = await reader.readExact(4, 1000);
    expect(buf.toString('ascii')).toBe('ABCD');
    const buf2 = await reader.readExact(2, 1000);
    expect(buf2.toString('ascii')).toBe('EF');
  });

  test('readExact waits for incoming data', async () => {
    const { stream, reader } = makeReader();
    const p = reader.readExact(4, 1000);
    setTimeout(() => stream.write('OKAY'), 20);
    const buf = await p;
    expect(buf.toString('ascii')).toBe('OKAY');
  });

  test('readExact rejects on EOF before n bytes', async () => {
    const { stream, reader } = makeReader();
    stream.write('AB');
    stream.end();
    await expect(reader.readExact(4, 1000)).rejects.toThrow(/EOF/);
  });

  test('readExact rejects on timeout', async () => {
    const { reader } = makeReader();
    await expect(reader.readExact(4, 50)).rejects.toThrow(/timeout/);
  });

  test('readAll resolves with the concatenated stream contents after end', async () => {
    const { stream, reader } = makeReader();
    stream.write('hello ');
    stream.write('world');
    stream.end();
    const out = await reader.readAll();
    expect(out).toBe('hello world');
  });

  test('multiple sequential readExact calls preserve order', async () => {
    const { stream, reader } = makeReader();
    const a = reader.readExact(3, 1000);
    const b = reader.readExact(3, 1000);
    stream.write('XYZABC');
    expect((await a).toString('ascii')).toBe('XYZ');
    expect((await b).toString('ascii')).toBe('ABC');
  });
});
