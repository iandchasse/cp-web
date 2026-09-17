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
export interface ManifestEntry {
  /** MEMFS destination, always under /fs_/ */
  path: string;
  /** Size of the file as written to MEMFS, after inflating and rejoining */
  size: number;
  defer?: boolean;
  url?: string;
  /** Served in pieces; concatenated in order before use */
  parts?: string[];
  /** Served pre-compressed with this Content-Encoding-style scheme */
  encoding?: 'gzip';
}
export function createFilesystemLoader(options: {
  getFS: () => Filesystem;
  baseUrl: string | URL;
  fetchImpl?: typeof fetch;
  onProgress?: (percent: number) => void;
  /** Fires as each deferred file lands, with how many deferred files remain */
  onDeferred?: (entry: ManifestEntry, remaining: number) => void;
  signal?: AbortSignal;
  /** Eager downloads in flight at once during prefetch (default 4) */
  concurrency?: number;
}): {
  state: FilesystemLoadState;
  /** Start the eager downloads before the runtime exists; loadEager writes them */
  prefetch(): Promise<ManifestEntry[]>;
  loadEager(): Promise<void>;
  loadDeferred(): Promise<void>;
  /** Deferred entries not yet written, in arrival order */
  pendingDeferred(): ManifestEntry[];
};
