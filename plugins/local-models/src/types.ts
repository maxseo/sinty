export type AssetRole = "weights" | "shard" | "mmproj";
export type AssetSource = "import" | "path";
export type InstanceStatus = "stopped" | "loading" | "ready" | "error";
export type CacheType = "f16" | "f32" | "bf16" | "q8_0" | "q4_0" | "q4_1" | "iq4_nl" | "q5_0" | "q5_1";
export type GpuLayers = number | "auto" | "all";

export interface AssetFile {
  name: string;
  /** Absolute path for source=path, or path relative to the asset directory for imports. */
  path: string;
  role: AssetRole;
  bytes: number;
}

export interface ModelAsset {
  id: string;
  title: string;
  source: AssetSource;
  files: AssetFile[];
  architecture?: string | undefined;
  contextLength?: number | undefined;
  createdAt: string;
}

export interface LaunchProfile {
  id: string;
  assetId: string;
  name: string;
  ctxSize: number;
  gpuLayers: GpuLayers;
  cacheTypeK: CacheType;
  cacheTypeV: CacheType;
  parallel: number;
  /** 0 = pick a free loopback port on start. */
  port: number;
  host: "127.0.0.1";
  createdAt: string;
}

export interface CatalogBinding {
  id: string;
  assetId: string;
  profileId: string;
  catalogRoute: string;
  alias: string;
  createdAt: string;
}

export interface EngineInfo {
  binaryPath: string;
  version?: string | undefined;
  source: "selected";
  probedAt: string;
}

export interface RuntimeInstance {
  profileId: string;
  pid: number | null;
  port: number;
  apiKey: string;
  startedAt: string;
  binaryPath: string;
  /** Confirms the process is the one we started, not a reused PID. */
  identity: string;
  status: InstanceStatus;
  lastError?: string | undefined;
}

export interface RegistryData {
  version: 1;
  assets: ModelAsset[];
  profiles: LaunchProfile[];
  bindings: CatalogBinding[];
  engine: EngineInfo | null;
  instance: RuntimeInstance | null;
  autostart: false;
}

export const CACHE_TYPES: readonly CacheType[] = ["f16", "f32", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"];
export const PROVIDER_ID = "sinty-local";
export const DEFAULT_PROFILE = {
  ctxSize: 0,
  gpuLayers: "auto" as GpuLayers,
  cacheTypeK: "f16" as CacheType,
  cacheTypeV: "f16" as CacheType,
  parallel: 1,
  port: 0,
  host: "127.0.0.1" as const,
};
