// ADBPD — DeviceTransport abstract interface.
//
// Every connected device (emulator, USB phone, Wi-Fi ADB) is represented by
// exactly one DeviceTransport implementation. The pool routes commands here.

export type TransportType = 'usb' | 'emulator' | 'tcp';

export type TransportState =
  | 'online'
  | 'offline'
  | 'unauthorized'
  | 'recovery'
  | 'disconnected';

export interface DeviceProperties {
  model?: string;
  manufacturer?: string;
  sdkVersion?: number;
  cpuAbi?: string;
  product?: string;
  [key: string]: string | number | undefined;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface InstallOptions {
  replace?: boolean;
  test?: boolean;
  downgrade?: boolean;
  grantRuntimePermissions?: boolean;
}

export interface Forward {
  local: string;
  remote: string;
  source?: 'maestro' | 'user' | 'adbpd';
}

export interface DeviceTransport {
  readonly serial: string;
  readonly type: TransportType;
  readonly state: TransportState;
  readonly port?: number;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;

  shell(command: string): Promise<ShellResult>;
  push(localPath: string, remotePath: string): Promise<void>;
  pull(remotePath: string, localPath: string): Promise<void>;
  install(apkPath: string, opts?: InstallOptions): Promise<void>;

  forward(local: string, remote: string): Promise<void>;
  listForwards(): Promise<Forward[]>;
  removeForward(local: string): Promise<void>;

  ping(): Promise<number>;
  getProperties(): Promise<DeviceProperties>;

  on(event: 'state-change', handler: (state: TransportState) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  off(event: 'state-change' | 'error', handler: (...args: never[]) => void): void;
}
