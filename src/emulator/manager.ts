// ADBPD — Emulator lifecycle manager.
//
// Launches AVDs with the canonical headless flag set, captures the spawned
// emulator process pid, picks the least-loaded NUMA node, and pins the
// process affinity within 500ms of spawn.
//
// The blueprint specifies AVD CRUD operations (create/destroy) for full
// daemon ownership of the AVD lifecycle. P5 implements only the start
// + stop + pin path; AVD CRUD is deferred to P7 (covered by Control API).

import { getLogger } from '../utils/logger.ts';
import {
  detectNumaTopology,
  isPidAlive,
  pickLeastLoadedNode,
  pinEmulatorVmChild,
  pinProcessToNode,
  type NumaNode,
  type NumaTopology,
} from './numa-pinner.ts';

const log = getLogger('emulator-manager');

const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_CORES = 4;

export interface ManagedEmulator {
  avdName: string;
  /** PID of the emulator.exe launcher (short-lived; spawns the VM child). */
  pid: number;
  /** PID of the qemu-system-x86_64-headless VM child (the real CPU consumer). */
  vmPid: number | undefined;
  consolePort: number;
  adbPort: number;
  numaNode: number;
  affinityMask: bigint;
  vmAffinityMask: bigint | undefined;
  memoryMb: number;
  startedAt: number;
}

export interface StartAvdOptions {
  avdName: string;
  emulatorBinary: string;
  consolePort: number;
  memoryMb?: number;
  cores?: number;
  /** Override the auto-selected NUMA node. */
  numaNodeOverride?: number;
}

export class EmulatorManager {
  private readonly topology: NumaTopology;
  private readonly assignments = new Map<number, number>(); // nodeNumber → count
  private readonly running = new Map<string, ManagedEmulator>(); // avdName → state

  constructor(topology?: NumaTopology) {
    this.topology = topology ?? detectNumaTopology();
  }

  getTopology(): NumaTopology {
    return this.topology;
  }

  /** Launch an AVD and pin its process to a NUMA node. */
  async startAvd(opts: StartAvdOptions): Promise<ManagedEmulator> {
    if (this.running.has(opts.avdName)) {
      throw new Error(`AVD ${opts.avdName} is already running`);
    }
    const node = this.pickNode(opts.numaNodeOverride);
    const args = this.buildEmulatorArgs({ ...opts, node });
    log.info({ avdName: opts.avdName, consolePort: opts.consolePort, node: node.nodeNumber }, 'spawning emulator');

    const proc = Bun.spawn([opts.emulatorBinary, ...args], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const pid = proc.pid;
    // Pin the launcher immediately. Goal is <500ms from spawn.
    const affinityMask = pinProcessToNode(pid, node);

    const state: ManagedEmulator = {
      avdName: opts.avdName,
      pid,
      vmPid: undefined,
      consolePort: opts.consolePort,
      adbPort: opts.consolePort + 1,
      numaNode: node.nodeNumber,
      affinityMask,
      vmAffinityMask: undefined,
      memoryMb: opts.memoryMb ?? DEFAULT_MEMORY_MB,
      startedAt: Date.now(),
    };
    this.running.set(opts.avdName, state);
    this.assignments.set(node.nodeNumber, (this.assignments.get(node.nodeNumber) ?? 0) + 1);

    // P5-N1: the launcher CreateProcess's a `qemu-system-x86_64-headless`
    // child that does NOT inherit affinity on Windows. Discover + pin it.
    void pinEmulatorVmChild(pid, node).then((vmInfo) => {
      if (vmInfo !== undefined) {
        state.vmPid = vmInfo.vmPid;
        state.vmAffinityMask = vmInfo.verifiedMask;
      }
    });

    // Detach from the proc — we don't await exited here; the emulator runs
    // until externally killed. The caller hooks teardown through stopAvd().
    proc.exited.catch(() => {
      /* expected on kill */
    });

    return state;
  }

  /** Look up state for a managed AVD by its serial (`emulator-<consolePort>`). */
  getBySerial(serial: string): ManagedEmulator | undefined {
    for (const m of this.running.values()) {
      if (`emulator-${m.consolePort}` === serial) return m;
    }
    return undefined;
  }

  /**
   * Recovery signal: returns true if the managed AVD's VM process is alive.
   * False means the qemu child is gone — the only fix is a full relaunch
   * (transport-level reconnect cannot resurrect a dead VM).
   *
   * Falls back to the launcher pid if vmPid was never discovered (e.g. very
   * early failure or non-Windows host).
   */
  isVmAlive(avdName: string): boolean {
    const m = this.running.get(avdName);
    if (m === undefined) return false;
    if (m.vmPid !== undefined) return isPidAlive(m.vmPid);
    return isPidAlive(m.pid);
  }

  /** Stop an emulator gracefully via the emulator console, then untrack. */
  async stopAvd(avdName: string, adbBinaryPath: string): Promise<void> {
    const state = this.running.get(avdName);
    if (state === undefined) {
      log.warn({ avdName }, 'stopAvd: not running');
      return;
    }
    log.info({ avdName, pid: state.pid }, 'stopping emulator');
    // adb -s emulator-<port> emu kill
    const serial = `emulator-${state.consolePort}`;
    const proc = Bun.spawn([adbBinaryPath, '-P', '5037', '-s', serial, 'emu', 'kill'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await proc.exited;
    this.running.delete(avdName);
    const count = (this.assignments.get(state.numaNode) ?? 1) - 1;
    if (count <= 0) this.assignments.delete(state.numaNode);
    else this.assignments.set(state.numaNode, count);
  }

  list(): ManagedEmulator[] {
    return Array.from(this.running.values());
  }

  private pickNode(override?: number): NumaNode {
    if (override !== undefined) {
      const node = this.topology.nodes.find((n) => n.nodeNumber === override);
      if (node === undefined) {
        throw new Error(`requested NUMA node ${override} not present in topology`);
      }
      return node;
    }
    return pickLeastLoadedNode(this.topology, this.assignments);
  }

  private buildEmulatorArgs(opts: StartAvdOptions & { node: NumaNode }): string[] {
    const args: string[] = [
      `@${opts.avdName}`,
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-no-snapshot',
      '-gpu',
      'swiftshader',
      '-memory',
      String(opts.memoryMb ?? DEFAULT_MEMORY_MB),
      '-cores',
      String(opts.cores ?? DEFAULT_CORES),
      '-port',
      String(opts.consolePort),
      '-timezone',
      'UTC',
      '-dns-server',
      '8.8.8.8',
    ];
    return args;
  }
}
