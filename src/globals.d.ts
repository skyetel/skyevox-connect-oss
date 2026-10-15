interface ElectronSettings {
  autoStart: boolean;
  minimizeToTray: boolean;
}

interface ElectronApi {
  isElectron: boolean;
  notifyIncomingCall(name: string, number: string): Promise<void>;
  setAutoStart(enabled: boolean): Promise<void>;
  setMinimizeToTray(enabled: boolean): Promise<void>;
  getSettings(): Promise<ElectronSettings | null>;
  logRenderer(level: string, message: string, data?: unknown): Promise<void>;
  getDiagnosticLogPath(): Promise<string | null>;
  storageGet(key: string): Promise<string | null>;
  storageSet(key: string, value: string): Promise<void>;
  storageRemove(key: string): Promise<void>;
  onDeepLink(callback: (url: string) => void): void;
}

interface Window {
  electronAPI?: ElectronApi;
  webkitAudioContext?: typeof AudioContext;
}
