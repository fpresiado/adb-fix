// Tests for the parser + scheduler — these run on every platform.
// The live FFI/affinity paths are exercised by the P5 milestone (live emu
// pin + readback) since they only work on Windows.

import { describe, expect, test } from 'bun:test';
import {
  parseNumaRecords,
  pickLeastLoadedNode,
  detectNumaTopology,
  type NumaNode,
} from '../../src/emulator/numa-pinner.ts';

describe('parseNumaRecords', () => {
  test('returns [] for empty buffer', () => {
    const buf = new Uint8Array(0);
    expect(parseNumaRecords(buf, 0)).toEqual([]);
  });

  test('parses a single NUMA node record', () => {
    // Build one synthetic SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX record:
    //   Relationship=1 (NumaNode), Size=48, NodeNumber=2, Mask=0xfff_000,
    //   Group=0.
    const buf = new Uint8Array(48);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 1, true); // Relationship = NumaNode
    dv.setUint32(4, 48, true); // Size
    dv.setUint32(8, 2, true); // NodeNumber
    // Reserved[20] left as zeros, then GROUP_AFFINITY at offset 32:
    dv.setBigUint64(32, 0xfff000n, true); // Mask
    dv.setUint16(40, 0, true); // Group
    const out = parseNumaRecords(buf, 48);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      nodeNumber: 2,
      group: 0,
      coreMask: 0xfff000n,
      coreCount: 12,
    });
  });

  test('skips non-NUMA records and walks until length', () => {
    // Two records: a "skip" record (Relationship=99, Size=24) then a NUMA
    // record (Size=48).
    const buf = new Uint8Array(72);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 99, true);
    dv.setUint32(4, 24, true);
    // skip record fields ignored
    dv.setUint32(24, 1, true); // NumaNode
    dv.setUint32(28, 48, true);
    dv.setUint32(32, 0, true); // NodeNumber
    dv.setBigUint64(56, 0xfn, true);
    dv.setUint16(64, 0, true);
    const out = parseNumaRecords(buf, 72);
    expect(out).toHaveLength(1);
    expect(out[0]?.nodeNumber).toBe(0);
    expect(out[0]?.coreMask).toBe(0xfn);
    expect(out[0]?.coreCount).toBe(4);
  });
});

describe('pickLeastLoadedNode', () => {
  const nodes: NumaNode[] = [
    { nodeNumber: 0, group: 0, coreMask: 0xfn, coreCount: 4 },
    { nodeNumber: 1, group: 0, coreMask: 0xf0n, coreCount: 4 },
    { nodeNumber: 2, group: 0, coreMask: 0xf00n, coreCount: 4 },
  ];
  const topo = { detected: true, source: 'ffi' as const, nodes };

  test('picks the first node when all are at zero', () => {
    const pick = pickLeastLoadedNode(topo, new Map());
    expect(pick.nodeNumber).toBe(0);
  });

  test('skips loaded nodes', () => {
    const pick = pickLeastLoadedNode(
      topo,
      new Map([
        [0, 2],
        [1, 0],
        [2, 1],
      ]),
    );
    expect(pick.nodeNumber).toBe(1);
  });

  test('throws when topology has no nodes', () => {
    expect(() =>
      pickLeastLoadedNode({ detected: false, source: 'fallback', nodes: [] }, new Map()),
    ).toThrow();
  });
});

describe('detectNumaTopology — live host', () => {
  test('returns at least one node on this Windows host (or fallback)', () => {
    const t = detectNumaTopology();
    expect(t.nodes.length).toBeGreaterThan(0);
    for (const n of t.nodes) {
      expect(n.coreMask).toBeGreaterThan(0n);
      expect(n.coreCount).toBeGreaterThan(0);
    }
  });
});
