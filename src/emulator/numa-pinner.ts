// ADBPD — NUMA detection + process affinity pinning (Windows).
//
// Uses Bun FFI to call kernel32 functions directly:
//   GetLogicalProcessorInformationEx — discover NUMA nodes + core masks
//   OpenProcess / CloseHandle        — get a handle for a child emulator pid
//   SetProcessAffinityMask           — pin the child to a die mask
//   GetProcessAffinityMask           — verify the pin
//   GetCurrentProcess                — pseudo-handle for pinning ourselves
//
// Pre-P5 spike (BUILD_REPORT §"Pre-P5 spike") confirmed FFI works on the
// host (Threadripper 2970WX). The real topology returned by Windows
// disagrees with the blueprint's hardcoded masks — runtime detection is
// the source of truth.

import { dlopen, FFIType, suffix } from 'bun:ffi';
import { getLogger } from '../utils/logger.ts';

const log = getLogger('numa-pinner');

const { u32, u64, i32, ptr } = FFIType;

const RELATION_NUMA_NODE = 1 as const;

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_SET_INFORMATION = 0x0200;
const PROCESS_QUERY_AND_SET = PROCESS_QUERY_INFORMATION | PROCESS_SET_INFORMATION;

let lib: ReturnType<typeof dlopen> | undefined;

function loadLib(): ReturnType<typeof dlopen> {
  if (lib !== undefined) return lib;
  lib = dlopen(`kernel32.${suffix}`, {
    GetLogicalProcessorInformationEx: { args: [i32, ptr, ptr], returns: i32 },
    OpenProcess: { args: [u32, i32, u32], returns: u64 },
    CloseHandle: { args: [u64], returns: i32 },
    GetCurrentProcess: { args: [], returns: u64 },
    SetProcessAffinityMask: { args: [u64, u64], returns: i32 },
    GetProcessAffinityMask: { args: [u64, ptr, ptr], returns: i32 },
  });
  return lib;
}

export interface NumaNode {
  nodeNumber: number;
  group: number;
  coreMask: bigint;
  coreCount: number;
}

export interface NumaTopology {
  detected: boolean;
  source: 'ffi' | 'fallback';
  nodes: NumaNode[];
}

/**
 * Hardcoded fallback used ONLY when FFI fails entirely.
 * The blueprint's values (Table 5) are incorrect for the 2970WX, but they
 * remain here as a portable best-effort default for hosts where detection
 * cannot run. Logged loudly when used.
 */
const HARDCODED_FALLBACK: readonly NumaNode[] = [
  { nodeNumber: 0, group: 0, coreMask: 0x3fn, coreCount: 6 },
  { nodeNumber: 1, group: 0, coreMask: 0xfc0n, coreCount: 6 },
];

/** Detect NUMA topology via Win32 API. Returns a fallback if detection fails. */
export function detectNumaTopology(): NumaTopology {
  try {
    const k = loadLib();
    const bufSize = new Uint32Array([32768]);
    const buf = new Uint8Array(bufSize[0]!);
    const ok = k.symbols.GetLogicalProcessorInformationEx(
      RELATION_NUMA_NODE,
      buf,
      bufSize,
    );
    if (!ok) {
      log.warn('GetLogicalProcessorInformationEx returned false; using fallback');
      return { detected: false, source: 'fallback', nodes: [...HARDCODED_FALLBACK] };
    }
    const nodes = parseNumaRecords(buf, bufSize[0]!);
    if (nodes.length === 0) {
      log.warn('NUMA detection parsed 0 nodes; using fallback');
      return { detected: false, source: 'fallback', nodes: [...HARDCODED_FALLBACK] };
    }
    log.info(
      { nodeCount: nodes.length, nodes: nodes.map((n) => ({ id: n.nodeNumber, mask: '0x' + n.coreMask.toString(16), cores: n.coreCount })) },
      'NUMA topology detected',
    );
    return { detected: true, source: 'ffi', nodes };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'NUMA FFI failed; using fallback');
    return { detected: false, source: 'fallback', nodes: [...HARDCODED_FALLBACK] };
  }
}

/**
 * Walk SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX records and extract
 * NUMA_NODE_RELATIONSHIP entries. Layout (x64):
 *   DWORD Relationship             // offset 0  (4 bytes)
 *   DWORD Size                     // offset 4  (4 bytes)
 *   --- payload begins at offset 8 ---
 *   NUMA_NODE_RELATIONSHIP:
 *     ULONG NodeNumber             // offset 8  (4 bytes)
 *     UCHAR Reserved[20]           // offset 12 (20 bytes)
 *     GROUP_AFFINITY Mask:
 *       KAFFINITY Mask             // offset 32 (8 bytes on x64)
 *       WORD     Group             // offset 40 (2 bytes)
 *       WORD     Reserved[3]       // offset 42 (6 bytes)
 */
export function parseNumaRecords(buf: Uint8Array, length: number): NumaNode[] {
  const out: NumaNode[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, length);
  let offset = 0;
  while (offset < length) {
    const rel = dv.getUint32(offset, true);
    const size = dv.getUint32(offset + 4, true);
    if (size === 0 || size > length - offset) break;
    if (rel === RELATION_NUMA_NODE) {
      const nodeNumber = dv.getUint32(offset + 8, true);
      const maskOff = offset + 8 + 4 + 20;
      const maskLo = dv.getBigUint64(maskOff, true);
      const group = dv.getUint16(maskOff + 8, true);
      out.push({
        nodeNumber,
        group,
        coreMask: maskLo,
        coreCount: popcount(maskLo),
      });
    }
    offset += size;
  }
  return out;
}

function popcount(n: bigint): number {
  let count = 0;
  let v = n;
  while (v !== 0n) {
    if ((v & 1n) === 1n) count++;
    v >>= 1n;
  }
  return count;
}

/**
 * Open a process handle for read+write affinity. Caller MUST call
 * `closeProcessHandle()` on the returned handle when done.
 * Returns 0n on failure (the user can check `=== 0n`).
 */
export function openProcessForAffinity(pid: number): bigint {
  const k = loadLib();
  return k.symbols.OpenProcess(PROCESS_QUERY_AND_SET, 0, pid);
}

export function closeProcessHandle(h: bigint): void {
  if (h === 0n) return;
  const k = loadLib();
  k.symbols.CloseHandle(h);
}

/** Set process affinity. Returns true on success. */
export function setProcessAffinity(handle: bigint, mask: bigint): boolean {
  const k = loadLib();
  return k.symbols.SetProcessAffinityMask(handle, mask) !== 0;
}

/** Read back affinity. Returns the process mask and system mask. */
export function getProcessAffinity(
  handle: bigint,
): { processMask: bigint; systemMask: bigint } | undefined {
  const k = loadLib();
  const procMaskBuf = new BigUint64Array(1);
  const sysMaskBuf = new BigUint64Array(1);
  const ok = k.symbols.GetProcessAffinityMask(handle, procMaskBuf, sysMaskBuf);
  if (ok === 0) return undefined;
  return { processMask: procMaskBuf[0]!, systemMask: sysMaskBuf[0]! };
}

/**
 * Pin the given pid to a NUMA node and verify the pin took effect.
 * Returns the verified mask (or throws on failure).
 */
export function pinProcessToNode(pid: number, node: NumaNode): bigint {
  const handle = openProcessForAffinity(pid);
  if (handle === 0n) {
    throw new Error(`OpenProcess(pid=${pid}) failed`);
  }
  try {
    const ok = setProcessAffinity(handle, node.coreMask);
    if (!ok) {
      throw new Error(`SetProcessAffinityMask(pid=${pid}, mask=0x${node.coreMask.toString(16)}) failed`);
    }
    const readback = getProcessAffinity(handle);
    if (readback === undefined) {
      throw new Error(`GetProcessAffinityMask(pid=${pid}) failed after set`);
    }
    if (readback.processMask !== node.coreMask) {
      log.warn(
        {
          pid,
          requested: '0x' + node.coreMask.toString(16),
          actual: '0x' + readback.processMask.toString(16),
        },
        'affinity readback differs from request (system may have masked some bits)',
      );
    }
    log.info(
      { pid, node: node.nodeNumber, mask: '0x' + readback.processMask.toString(16) },
      'process pinned',
    );
    return readback.processMask;
  } finally {
    closeProcessHandle(handle);
  }
}

/**
 * Simple round-robin scheduler: returns the NUMA node with the fewest
 * currently-assigned emulators (caller tracks assignments).
 */
export function pickLeastLoadedNode(
  topology: NumaTopology,
  assignmentsPerNode: ReadonlyMap<number, number>,
): NumaNode {
  if (topology.nodes.length === 0) {
    throw new Error('NUMA topology has zero nodes');
  }
  let best = topology.nodes[0]!;
  let bestCount = assignmentsPerNode.get(best.nodeNumber) ?? 0;
  for (const n of topology.nodes.slice(1)) {
    const count = assignmentsPerNode.get(n.nodeNumber) ?? 0;
    if (count < bestCount) {
      best = n;
      bestCount = count;
    }
  }
  return best;
}
