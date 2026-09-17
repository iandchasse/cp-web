export interface Filesystem {
  mkdirTree(path: string): void;
  writeFile(path: string, bytes: Uint8Array): void;
}
export interface FilesystemLoadState {
  eagerPct: number;
  deferTotal: number;
  deferDone: number;
  ready: boolean;
  error: string | null;
}
export function createFilesystemLoader(options: {
  getFS: () => Filesystem;
  baseUrl: string | URL;
  fetchImpl?: typeof fetch;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}): {
  state: FilesystemLoadState;
  loadEager(): Promise<void>;
  loadDeferred(): Promise<void>;
};
