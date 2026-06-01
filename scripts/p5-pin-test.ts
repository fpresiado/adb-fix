// P5 live milestone: detect topology, launch one AVD, pin it, read back the
// affinity via PowerShell Get-Process and confirm it matches.

import { spawnSync } from 'node:child_process';
import { EmulatorManager } from '../src/emulator/manager.ts';

const EMULATOR_BIN = 'C:/Users/plusu/AppData/Local/Android/Sdk/emulator/emulator.exe';
const AVD = 'Pixel_9_Pro';
const PORT = 5554;

async function main(): Promise<void> {
  const mgr = new EmulatorManager();
  const topo = mgr.getTopology();
  console.log('TOPOLOGY:', JSON.stringify({
    source: topo.source,
    detected: topo.detected,
    nodes: topo.nodes.map((n) => ({
      node: n.nodeNumber,
      mask: '0x' + n.coreMask.toString(16),
      cores: n.coreCount,
    })),
  }, null, 2));

  console.log('\nLaunching AVD...');
  const state = await mgr.startAvd({
    avdName: AVD,
    emulatorBinary: EMULATOR_BIN,
    consolePort: PORT,
  });
  console.log('LAUNCHED:', {
    pid: state.pid,
    consolePort: state.consolePort,
    node: state.numaNode,
    requestedMask: '0x' + state.affinityMask.toString(16),
  });

  // Verify via PowerShell — independent of our FFI call.
  await new Promise((r) => setTimeout(r, 1500));
  const psResult = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${state.pid}).ProcessorAffinity.ToInt64()`,
    ],
    { encoding: 'utf8' },
  );
  const psOut = psResult.stdout.trim();
  const psMask = BigInt(psOut);
  console.log('VERIFY via Get-Process:');
  console.log('  pid:', state.pid);
  console.log('  ProcessorAffinity:', '0x' + psMask.toString(16));
  console.log('  expected:        ', '0x' + state.affinityMask.toString(16));
  console.log('  match:', psMask === state.affinityMask);

  // Give time for emulator boot to start; that's enough for the milestone.
  console.log('\nLeaving emulator running. To stop manually:');
  console.log(`  adb -s emulator-${PORT} emu kill`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
