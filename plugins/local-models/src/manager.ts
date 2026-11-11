import { copyFileSync, mkdirSync, rmSync, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { inspectGguf, findSiblingShards } from "./gguf.js";
import { probeBinary, resolveExistingBinary, suggestBinaryLocations } from "./engine.js";
import {
  assetsDir,
  ensureLayout,
  loadRegistry,
  newId,
  purgeAssetFiles,
  removeAsset,
  removeBinding,
  runtimeDir,
  saveRegistry,
  setEngine,
  setInstance,
  upsertAsset,
  upsertBinding,
  upsertProfile,
} from "./registry.js";
import {
  checkHealth,
  confirmOwnServer,
  isPortFree,
  mmprojPath,
  pickFreePort,
  primaryWeights,
  redactText,
  signalOwnPort,
  spawnOwned,
  stopOwned,
  tailLog,
  writeApiKeyFile,
  type OwnedProcess,
} from "./process.js";
import { isAbsolutePath, parseAlias, profileFields } from "./validate.js";
import { DEFAULT_PROFILE, PROVIDER_ID, type InstanceStatus, type LaunchProfile, type ModelAsset, type RegistryData, type RuntimeInstance } from "./types.js";

export interface ManagerOptions {
  dataDir: string;
  hostname?: string | undefined;
}

export class LocalModelsManager {
  readonly dataDir: string;
  readonly hostname: string;
  private owned: OwnedProcess | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: ManagerOptions) {
    this.dataDir = opts.dataDir;
    this.hostname = opts.hostname ?? (process.env.COMPUTERNAME || process.env.HOSTNAME || "sinty-host");
    ensureLayout(this.dataDir);
  }

  load(): RegistryData {
    return loadRegistry(this.dataDir);
  }

  locationBanner(): string {
    return `Сервер моделей запускается на машине процесса Sinty (${this.hostname}), не в браузере и не на другом устройстве. В Docker это сеть контейнера, localhost — сам контейнер.`;
  }

  state(): Record<string, unknown> {
    const reg = this.load();
    const instance = this.publicInstance(reg);
    return {
      location: this.locationBanner(),
      hostname: this.hostname,
      platform: process.platform,
      engine: reg.engine,
      suggestedBinaries: suggestBinaryLocations(),
      assets: reg.assets,
      profiles: reg.profiles,
      bindings: reg.bindings,
      instance,
      autostart: false,
      capabilitiesNote: "Поддержка tool calling и зрения зависит от модели и шаблона чата; плагин это не утверждает автоматически.",
      memoryNote: "Оценка памяти приблизительная, не гарантия. Значения по умолчанию консервативны.",
      engineInstallNote: "Автоустановка официального llama.cpp в этой версии не включена: укажите путь к уже установленному llama-server.",
    };
  }

  private publicInstance(reg: RegistryData): (Omit<RuntimeInstance, "apiKey"> & { status: InstanceStatus }) | null {
    if (!reg.instance) return null;
    const { apiKey: _k, ...rest } = reg.instance;
    void _k;
    return rest;
  }

  async selectEngine(path: string): Promise<RegistryData> {
    const probed = await probeBinary(path);
    const reg = setEngine(this.load(), { binaryPath: probed.binaryPath, version: probed.version, source: "selected", probedAt: new Date().toISOString() });
    saveRegistry(this.dataDir, reg);
    return reg;
  }

  async commitImport(opts: { filePaths: string[]; title?: string | undefined; associateMmproj?: string | undefined }): Promise<ModelAsset> {
    if (!opts.filePaths.length) throw new Error("нет файлов для импорта");
    const infos = opts.filePaths.map((p) => inspectGguf(p));
    const projectors = infos.filter((i) => i.kind === "mmproj");
    const mains = infos.filter((i) => i.kind !== "mmproj");
    if (!mains.length && projectors.length) throw new Error("это проектор (mmproj), а не основная модель; сначала импортируйте GGUF модели");
    if (mains.length !== 1 && !mains.every((m) => findSiblingShards(m.path))) {
      // multiple non-shard files: not a single model
      if (mains.length !== 1) throw new Error("в одном импорте должна быть одна основная модель (или полный набор шардов)");
    }
    let weightPaths = [mains[0]!.path];
    const shards = findSiblingShards(mains[0]!.path);
    if (shards) {
      const uploaded = new Set(opts.filePaths.map((p) => resolve(p)));
      const missing = shards.filter((s) => !uploaded.has(resolve(s)) && !opts.filePaths.includes(s));
      // If user imported one shard from our staging, siblings may still be only on original dir.
      // For imported staging files, require all shards to be in the provided list.
      if (missing.length && opts.filePaths.length > 1) throw new Error(`не хватает частей разделённой модели: ${missing.map((s) => basename(s)).join(", ")}`);
      if (opts.filePaths.length === shards.length) weightPaths = shards;
      else if (opts.filePaths.length === 1 && shards.length > 1) throw new Error(`это часть разделённой модели (${shards.length} файлов). Загрузите все части сразу.`);
    }
    const mmprojSrc = opts.associateMmproj ?? projectors[0]?.path;
    if (opts.associateMmproj) {
      const mm = inspectGguf(opts.associateMmproj);
      if (mm.kind !== "mmproj") throw new Error("указанный файл не похож на mmproj");
    }
    const primary = inspectGguf(weightPaths[0]!);
    const id = newId("m");
    const destDir = join(assetsDir(this.dataDir), id);
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const files: ModelAsset["files"] = [];
    try {
      for (const [i, src] of weightPaths.entries()) {
        const name = basename(src);
        const dest = join(destDir, name);
        copyFileSync(src, dest);
        files.push({ name, path: dest, role: weightPaths.length > 1 ? "shard" : "weights", bytes: statSync(dest).size });
        void i;
      }
      if (mmprojSrc) {
        const name = basename(mmprojSrc);
        const dest = join(destDir, name);
        copyFileSync(mmprojSrc, dest);
        files.push({ name, path: dest, role: "mmproj", bytes: statSync(dest).size });
      }
    } catch (e) {
      rmSync(destDir, { recursive: true, force: true });
      throw e;
    }
    const asset: ModelAsset = {
      id,
      title: opts.title?.trim() || primary.name || basename(weightPaths[0]!),
      source: "import",
      files,
      architecture: primary.architecture,
      contextLength: primary.contextLength,
      createdAt: new Date().toISOString(),
    };
    const reg = upsertAsset(this.load(), asset);
    const profile = this.defaultProfile(asset.id);
    saveRegistry(this.dataDir, upsertProfile(reg, profile));
    return asset;
  }

  registerExistingPath(rawPath: string, title?: string | undefined, mmprojRaw?: string | undefined): ModelAsset {
    const path = resolve(rawPath.trim());
    if (!isAbsolutePath(path)) throw new Error("укажите абсолютный путь на машине Sinty");
    if (!existsSync(path)) throw new Error("файл не найден на машине Sinty");
    if (lstatSync(path).isSymbolicLink()) {
      realpathSync(path);
    }
    if (!lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) throw new Error("это не файл");
    const info = inspectGguf(path);
    if (info.kind === "mmproj") throw new Error(info.reason ?? "это проектор, а не основная модель");
    let files: ModelAsset["files"] = [{ name: basename(path), path, role: "weights", bytes: info.bytes }];
    const shards = findSiblingShards(path);
    if (shards) {
      files = shards.map((p, i) => ({ name: basename(p), path: p, role: i === 0 && shards.length === 1 ? "weights" : "shard" as const, bytes: statSync(p).size }));
    }
    if (mmprojRaw) {
      const mm = resolve(mmprojRaw.trim());
      if (!isAbsolutePath(mm) || !existsSync(mm)) throw new Error("mmproj не найден");
      const mmInfo = inspectGguf(mm);
      if (mmInfo.kind !== "mmproj") throw new Error("указанный файл не похож на mmproj");
      files.push({ name: basename(mm), path: mm, role: "mmproj", bytes: mmInfo.bytes });
    }
    const asset: ModelAsset = {
      id: newId("m"),
      title: title?.trim() || info.name || basename(path),
      source: "path",
      files,
      architecture: info.architecture,
      contextLength: info.contextLength,
      createdAt: new Date().toISOString(),
    };
    const reg = upsertAsset(this.load(), asset);
    saveRegistry(this.dataDir, upsertProfile(reg, this.defaultProfile(asset.id)));
    return asset;
  }

  saveProfile(input: Record<string, unknown>): LaunchProfile {
    const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : newId("p");
    const assetId = String(input.assetId ?? "");
    const reg = this.load();
    if (!reg.assets.some((a) => a.id === assetId)) throw new Error("модель не найдена");
    const current = this.owned && reg.instance?.profileId === id;
    if (current && (input.ctxSize !== undefined || input.gpuLayers !== undefined || input.cacheTypeK !== undefined || input.port !== undefined)) {
      throw new Error("нужно подтвердить перезапуск: изменение профиля прервёт активные запросы");
    }
    const existing = reg.profiles.find((p) => p.id === id);
    const profile: LaunchProfile = {
      id,
      assetId,
      name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : existing?.name ?? "По умолчанию",
      ...profileFields({ ...DEFAULT_PROFILE, ...existing, ...input }),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    saveRegistry(this.dataDir, upsertProfile(reg, profile));
    return profile;
  }

  deleteAsset(id: string, confirmRunning = false): void {
    let reg = this.load();
    const asset = reg.assets.find((a) => a.id === id);
    if (!asset) throw new Error("модель не найдена");
    if (reg.instance && reg.profiles.some((p) => p.id === reg.instance!.profileId && p.assetId === id)) {
      if (!confirmRunning) throw new Error("модель запущена: подтвердите остановку");
    }
    if (this.owned && reg.instance && reg.profiles.some((p) => p.id === reg.instance!.profileId && p.assetId === id)) {
      throw new Error("сначала остановите сервер");
    }
    reg = removeAsset(reg, id);
    saveRegistry(this.dataDir, reg);
    purgeAssetFiles(this.dataDir, asset);
  }

  bindCatalog(profileId: string, aliasRaw?: string | undefined): { binding: RegistryData["bindings"][number]; provider: { id: string; protocol: "openai-compat"; baseUrl: string; apiKey?: string | undefined }; route: string } {
    const reg = this.load();
    const profile = reg.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error("профиль не найден");
    const asset = reg.assets.find((a) => a.id === profile.assetId);
    if (!asset) throw new Error("модель не найдена");
    const alias = parseAlias(aliasRaw ?? asset.id);
    const route = `${PROVIDER_ID}/${alias}`;
    const binding = {
      id: newId("b"),
      assetId: asset.id,
      profileId: profile.id,
      catalogRoute: route,
      alias,
      createdAt: new Date().toISOString(),
    };
    const existing = reg.bindings.find((b) => b.catalogRoute === route || b.profileId === profileId);
    const next = upsertBinding(reg, existing ? { ...existing, alias, catalogRoute: route, profileId, assetId: asset.id } : binding);
    saveRegistry(this.dataDir, next);
    const port = this.load().instance?.port ?? profile.port;
    const baseUrl = `http://127.0.0.1:${port && port > 0 ? port : 18790}/v1`;
    const apiKey = this.load().instance?.apiKey;
    return { binding: existing ? { ...existing, alias, catalogRoute: route, profileId, assetId: asset.id } : binding, provider: { id: PROVIDER_ID, protocol: "openai-compat", baseUrl, ...(apiKey ? { apiKey } : {}) }, route };
  }

  unbindCatalog(route: string): void {
    saveRegistry(this.dataDir, removeBinding(this.load(), route));
  }

  async start(profileId: string): Promise<RuntimeInstance> {
    const reg = this.load();
    if (!reg.engine) throw new Error("сначала укажите путь к llama-server");
    resolveExistingBinary(reg.engine.binaryPath);
    const profile = reg.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error("профиль не найден");
    const asset = reg.assets.find((a) => a.id === profile.assetId);
    if (!asset) throw new Error("модель не найдена");
    if (this.owned) throw new Error("уже запущен один управляемый llama-server; остановите его, прежде чем стартовать другой");
    if (reg.instance && (await confirmOwnServer(reg.instance.port, reg.instance.apiKey))) {
      throw new Error("уже запущен один управляемый llama-server; остановите его, прежде чем стартовать другой");
    }

    let port = profile.port;
    if (port && port > 0) {
      const free = await isPortFree(port);
      if (!free) {
        if (reg.instance && reg.instance.port === port) {
          const own = await confirmOwnServer(port, reg.instance.apiKey);
          if (own) throw new Error("сервер уже запущен");
        }
        throw new Error(`порт ${port} занят другим процессом; выберите другой. Чужой процесс не будет перехвачен.`);
      }
    } else {
      port = await pickFreePort();
    }

    const apiKey = randomBytes(24).toString("hex");
    const apiKeyFile = writeApiKeyFile(this.dataDir, apiKey);
    const alias = reg.bindings.find((b) => b.profileId === profile.id)?.alias ?? asset.id;
    const owned = spawnOwned(this.dataDir, {
      binaryPath: reg.engine.binaryPath,
      modelPath: primaryWeights(asset),
      mmprojPath: mmprojPath(asset),
      profile,
      port,
      alias,
      apiKeyFile,
    });
    this.owned = owned;
    const inst: RuntimeInstance = {
      profileId: profile.id,
      pid: owned.pid,
      port,
      apiKey,
      startedAt: owned.startedAt,
      binaryPath: owned.binaryPath,
      identity: owned.identity,
      status: "loading",
    };
    saveRegistry(this.dataDir, setInstance(this.load(), inst));
    this.watchHealth();
    const health = await this.refreshHealth();
    return health;
  }

  async stop(confirm = true): Promise<void> {
    const reg = this.load();
    if (!reg.instance && !this.owned) return;
    if (!confirm) throw new Error("нужно подтверждение остановки");
    if (this.owned) {
      await stopOwned(this.owned);
      this.owned = undefined;
    } else if (reg.instance) {
      const own = await confirmOwnServer(reg.instance.port, reg.instance.apiKey);
      if (own) {
        const stopped = await signalOwnPort(reg.instance.port, reg.instance.apiKey);
        if (!stopped) throw new Error("не удалось безопасно остановить свой сервер: на порту по-прежнему отвечает наш ключ, но процесс не найден. Чужой процесс не трогаю.");
      }
    }
    this.clearHealthTimer();
    saveRegistry(this.dataDir, setInstance(this.load(), null));
  }

  /**
   * After plugin/Sinty restart: adopt our server if the recorded port still answers our API key.
   * Never adopt a foreign process. Never start a new server (autostart is off).
   */
  async reconcile(): Promise<void> {
    const reg = this.load();
    if (!reg.instance) return;
    const health = await checkHealth(reg.instance.port, reg.instance.apiKey);
    if (health.status === "ready" || health.status === "loading") {
      saveRegistry(this.dataDir, setInstance(this.load(), { ...reg.instance, status: health.status, lastError: undefined }));
      this.watchHealth();
      return;
    }
    if (health.status === "error" && health.http && (health.http === 401 || health.http === 403)) {
      saveRegistry(this.dataDir, setInstance(this.load(), { ...reg.instance, status: "error", lastError: health.detail, pid: null }));
      return;
    }
    // Process gone or port free: drop stale instance, do not start another.
    saveRegistry(this.dataDir, setInstance(this.load(), null));
  }

  async refreshHealth(): Promise<RuntimeInstance> {
    const reg = this.load();
    if (!reg.instance) throw new Error("сервер не запущен");
    if (this.owned && this.owned.child.exitCode !== null) {
      const inst: RuntimeInstance = { ...reg.instance, status: "error", lastError: `процесс завершился с кодом ${this.owned.child.exitCode}`, pid: this.owned.pid };
      this.owned = undefined;
      saveRegistry(this.dataDir, setInstance(this.load(), inst));
      return inst;
    }
    const health = await checkHealth(reg.instance.port, reg.instance.apiKey);
    let status: InstanceStatus = "error";
    if (health.status === "ready") status = "ready";
    else if (health.status === "loading") status = "loading";
    else if (health.status === "down") status = this.owned ? "loading" : "error";
    const inst: RuntimeInstance = {
      ...reg.instance,
      status,
      lastError: status === "error" ? health.detail : undefined,
    };
    saveRegistry(this.dataDir, setInstance(this.load(), inst));
    return inst;
  }

  journal(): { text: string; file?: string | undefined } {
    const reg = this.load();
    const file = this.owned?.logFile ?? (reg.instance ? join(this.dataDir, "logs", `server-${reg.instance.port}.log`) : undefined);
    const secrets = [reg.instance?.apiKey ?? "", this.owned?.apiKey ?? ""].filter(Boolean);
    return { text: redactText(file ? tailLog(file) : "", secrets), file };
  }

  async dispose(): Promise<void> {
    this.clearHealthTimer();
    if (this.owned) {
      await stopOwned(this.owned);
      this.owned = undefined;
      saveRegistry(this.dataDir, setInstance(this.load(), null));
    }
  }

  providerSnapshot(): { id: string; protocol: "openai-compat"; baseUrl: string; apiKey?: string | undefined } | undefined {
    const inst = this.load().instance;
    if (!inst) return undefined;
    return { id: PROVIDER_ID, protocol: "openai-compat", baseUrl: `http://127.0.0.1:${inst.port}/v1`, apiKey: inst.apiKey };
  }

  private defaultProfile(assetId: string): LaunchProfile {
    return {
      id: newId("p"),
      assetId,
      name: "По умолчанию",
      ...DEFAULT_PROFILE,
      createdAt: new Date().toISOString(),
    };
  }

  private watchHealth(): void {
    this.clearHealthTimer();
    this.healthTimer = setInterval(() => {
      void this.refreshHealth().catch(() => undefined);
    }, 2000);
    this.healthTimer.unref?.();
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }
}

