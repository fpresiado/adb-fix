// USB enumerator unit tests — focus on the `adb devices -l` parser since the
// transient-server spawn requires a real adb binary (covered by P3 milestone).

import { describe, expect, test } from 'bun:test';
import { parseDevicesLong } from '../../src/usb/enumerator.ts';

describe('parseDevicesLong', () => {
  test('returns empty list for the empty header response', () => {
    const out = parseDevicesLong('List of devices attached\n');
    expect(out).toEqual([]);
  });

  test('parses one physical device with full metadata', () => {
    const raw = `List of devices attached
R5CN90VPWQW            device product:c2quew model:SM_N986U1 device:c2q transport_id:1
`;
    const out = parseDevicesLong(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      serial: 'R5CN90VPWQW',
      model: 'SM_N986U1',
      product: 'c2quew',
      transportId: '1',
    });
  });

  test('parses multiple physical devices', () => {
    const raw = `List of devices attached
R5CN90VPWQW            device product:c2quew model:SM_N986U1 device:c2q transport_id:1
ABCDEF                 device product:flame model:Pixel_4 device:flame transport_id:2
`;
    const out = parseDevicesLong(raw);
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.serial).sort()).toEqual(['ABCDEF', 'R5CN90VPWQW']);
  });

  test('filters out emulator serials', () => {
    const raw = `List of devices attached
emulator-5554          device product:sdk_gphone64_x86_64 model:emulator transport_id:1
R5CN90VPWQW            device product:c2quew model:SM_N986U1 transport_id:2
`;
    const out = parseDevicesLong(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.serial).toBe('R5CN90VPWQW');
  });

  test('filters out unauthorized/offline devices', () => {
    const raw = `List of devices attached
ABC123                 unauthorized
XYZ789                 offline
GOODDEV                device product:p model:m transport_id:1
`;
    const out = parseDevicesLong(raw);
    expect(out.map((d) => d.serial)).toEqual(['GOODDEV']);
  });

  test('handles unparseable junk lines gracefully', () => {
    const raw = `List of devices attached

junk_no_state
GOODDEV                device transport_id:1
`;
    const out = parseDevicesLong(raw);
    expect(out.map((d) => d.serial)).toEqual(['GOODDEV']);
  });
});
