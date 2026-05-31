// spike-numa.ts — Bun FFI sanity check before P5 writes a line.
// Run with: bun run scripts/spike-numa.ts

import { dlopen, FFIType, suffix } from 'bun:ffi';

const kernel32 = dlopen(`kernel32.${suffix}`, {
  GetLogicalProcessorInformationEx: {
    args: [FFIType.i32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.bool,
  },
  GetLastError: {
    args: [],
    returns: FFIType.u32,
  },
});

const RelationNumaNode = 1;
const RelationProcessorCore = 0;
const RelationProcessorPackage = 3;

function callOnce(relation: number, label: string): void {
  console.log(`\n=== ${label} (RelationshipType=${relation}) ===`);
  const bufferSize = new Uint32Array([32768]);
  const buffer = new Uint8Array(bufferSize[0]!);
  const ok = kernel32.symbols.GetLogicalProcessorInformationEx(
    relation,
    buffer,
    bufferSize,
  );
  const lastError = kernel32.symbols.GetLastError();
  console.log('FFI call succeeded:', !!ok);
  console.log('GetLastError:', lastError);
  console.log('ReturnedLength:', bufferSize[0]);
  if (!ok) return;

  // Walk SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX records.
  // typedef struct _SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX {
  //   LOGICAL_PROCESSOR_RELATIONSHIP Relationship;  // 4 bytes
  //   DWORD                          Size;          // 4 bytes
  //   union { ... } payload;                        // payload starts at offset 8
  // };
  const dv = new DataView(buffer.buffer);
  let offset = 0;
  let count = 0;
  while (offset < bufferSize[0]!) {
    const rel = dv.getUint32(offset, true);
    const size = dv.getUint32(offset + 4, true);
    count++;
    if (rel === RelationNumaNode && relation === RelationNumaNode) {
      // NUMA_NODE_RELATIONSHIP { ULONG NodeNumber; UCHAR Reserved[20]; GROUP_AFFINITY Mask; }
      const nodeNumber = dv.getUint32(offset + 8, true);
      // GROUP_AFFINITY: KAFFINITY Mask (ULONG_PTR = 8 bytes on x64); WORD Group; WORD Reserved[3];
      const maskOff = offset + 8 + 4 + 20;
      const maskLo = dv.getUint32(maskOff, true);
      const maskHi = dv.getUint32(maskOff + 4, true);
      const group = dv.getUint16(maskOff + 8, true);
      console.log(
        `  NumaNode ${nodeNumber}: group=${group} mask=0x${maskHi.toString(16).padStart(8, '0')}${maskLo.toString(16).padStart(8, '0')}`,
      );
    }
    if (rel === RelationProcessorPackage && relation === RelationProcessorPackage) {
      console.log(`  ProcessorPackage record size=${size}`);
    }
    offset += size;
    if (size === 0) break;
  }
  console.log(`Walked ${count} records.`);
}

callOnce(RelationNumaNode, 'NUMA nodes');
callOnce(RelationProcessorPackage, 'Processor packages');

kernel32.close();
