import { describe, expect, test } from 'bun:test';
import { computeSignature, FmClient } from '../../src/fm/client.ts';
import { createHash, createHmac } from 'node:crypto';

describe('computeSignature — canonical HMAC pattern', () => {
  test('matches a manual recomputation for an empty body', () => {
    const token = 'sekret';
    const installId = 'abc-123';
    const ts = 1700000000;
    const sig = computeSignature(token, installId, ts, '');
    const expected = createHmac('sha256', token)
      .update(`${installId}:${ts}:${createHash('sha256').update('').digest('hex')}`)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  test('uses the inner SHA-256 of the body', () => {
    const token = 'k';
    const installId = 'i';
    const ts = 1;
    const body = JSON.stringify({ a: 1, b: [2, 3] });
    const sig = computeSignature(token, installId, ts, body);
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const expected = createHmac('sha256', token).update(`i:1:${bodyHash}`).digest('hex');
    expect(sig).toBe(expected);
  });

  test('output is lowercase hex', () => {
    const sig = computeSignature('k', 'i', 1, '');
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });
});

describe('FmClient — disabled mode', () => {
  test('throws when request() is called while disabled', async () => {
    const c = new FmClient({
      enabled: false,
      url: 'http://localhost:65535',
      installId: 'a',
      token: 'b',
    });
    expect(c.enabled).toBe(false);
    await expect(c.request({ method: 'POST', path: '/x' })).rejects.toThrow(/disabled/);
  });
});
