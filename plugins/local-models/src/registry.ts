import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CatalogBinding, EngineInfo, LaunchProfile, ModelAsset, RegistryData, RuntimeInstance } from "./types.js";

export const REGISTRY_VERSION = 1 as const;

export function emptyRegistry(): RegistryData {
  return { version: 1, assets: [], profiles: [], bindings: [], engine: null, instance: null, autostart: false };
}

export function newId(prefix = ""): string {
  return `${prefix}${randomBytes(8).toString("hex")}`;
}

export function registryPath(dataDir: string): string {
  return join(dataDir, "registry.json");
}

export function assetsDir(dataDir: string): string {
  return join(dataDir, "models");
}

export function logsDir(dataDir: string): string {
  return join(dataDir, "logs");
}

export function runtimeDir(dataDir: string): string {
  return join(dataDir, "runtime");
}

export function loadRegistry(dataDir: string): RegistryData {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = registryPath(dataDir);
  if (!existsSync(file)) return emptyRegistry();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RegistryData>;
  if (raw.version !== 1 || !Array.isArray(raw.assets) || !Array.isArray(raw.profiles) || !Array.isArray(raw.bindings)) {
    throw new Error("реестр локальных моделей повреждён");
  }
  return {
    version: 1,
    assets: raw.assets as ModelAsset[],
    profiles: raw.profiles as LaunchProfile[],
    bindings: raw.bindings as CatalogBinding[],
    engine: (raw.engine as EngineInfo | null) ?? null,
    instance: (raw.instance as RuntimeInstance | null) ?? null,
    autostart: false,
  };
}

export function saveRegistry(dataDir: string, data: RegistryData): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = registryPath(dataDir);
  const tmp = join(dataDir, `.registry.${randomBytes(4).toString("hex")}.tmp`);
  const payload: RegistryData = { ...data, version: 1, autostart: false };
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export function upsertAsset(reg: RegistryData, asset: ModelAsset): RegistryData {
  return { ...reg, assets: [...reg.assets.filter((a) => a.id !== asset.id), asset] };
}

export function upsertProfile(reg: RegistryData, profile: LaunchProfile): RegistryData {
  return { ...reg, profiles: [...reg.profiles.filter((p) => p.id !== profile.id), profile] };
}

export function upsertBinding(reg: RegistryData, binding: CatalogBinding): RegistryData {
  return { ...reg, bindings: [...reg.bindings.filter((b) => b.id !== binding.id && b.catalogRoute !== binding.catalogRoute), binding] };
}

export function removeAsset(reg: RegistryData, id: string): RegistryData {
  if (reg.instance && reg.profiles.some((p) => p.id === reg.instance!.profileId && p.assetId === id)) {
    throw new Error("нельзя удалить модель, пока запущен её сервер");
  }
  if (reg.bindings.some((b) => b.assetId === id)) throw new Error("сначала уберите модель из каталога агентов");
  return { ...reg, assets: reg.assets.filter((a) => a.id !== id), profiles: reg.profiles.filter((p) => p.assetId !== id) };
}

export function removeBinding(reg: RegistryData, catalogRoute: string): RegistryData {
  return { ...reg, bindings: reg.bindings.filter((b) => b.catalogRoute !== catalogRoute) };
}

export function setInstance(reg: RegistryData, instance: RuntimeInstance | null): RegistryData {
  return { ...reg, instance };
}

export function setEngine(reg: RegistryData, engine: EngineInfo | null): RegistryData {
  return { ...reg, engine };
}

export function purgeAssetFiles(dataDir: string, asset: ModelAsset): void {
  if (asset.source !== "import") return;
  rmSync(join(assetsDir(dataDir), asset.id), { recursive: true, force: true });
}

export function ensureLayout(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(assetsDir(dataDir), { recursive: true, mode: 0o700 });
  mkdirSync(logsDir(dataDir), { recursive: true, mode: 0o700 });
  mkdirSync(runtimeDir(dataDir), { recursive: true, mode: 0o700 });
}
