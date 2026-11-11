import { definePlugin } from "@sinty/sdk";
import { LocalModelsManager } from "./manager.js";
import { tabHtml } from "./page.js";
import { readStagedUpload, removeStagedUpload } from "./staged-upload.js";

const TAB_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function fail(message: string, status = 400): Response {
  return Response.json({ error: { code: "bad_request", message } }, { status });
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

let manager: LocalModelsManager | undefined;

export default definePlugin({
  name: "local-models",
  async setup(ctx) {
    const mgr = new LocalModelsManager({ dataDir: ctx.paths.data });
    manager = mgr;
    await mgr.reconcile();

    ctx.http({
      method: "GET",
      path: "/tab",
      public: true,
      surface: "models",
      handler: () =>
        new Response(tabHtml(), {
          headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": TAB_CSP, "cache-control": "no-store" },
        }),
    });

    ctx.http({
      method: "GET",
      path: "/state",
      surface: "models",
      access: "view",
      handler: () => json(mgr.state()),
    });

    ctx.http({
      method: "GET",
      path: "/journal",
      surface: "models",
      access: "view",
      handler: () => json(mgr.journal()),
    });

    ctx.http({
      method: "POST",
      path: "/engine/select",
      surface: "models",
      access: "edit",
      async handler(req) {
        try {
          const body = await bodyOf(req);
          if (typeof body.path !== "string") return fail("укажите путь к llama-server");
          await mgr.selectEngine(body.path);
          return json(mgr.state());
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/imports/commit",
      surface: "models",
      access: "edit",
      async handler(req) {
        try {
          const body = await bodyOf(req);
          const ids = Array.isArray(body.uploadIds) ? body.uploadIds.filter((id): id is string => typeof id === "string") : [];
          if (!ids.length) return fail("нет загруженных файлов");
          const paths = ids.map((id) => readStagedUpload(ctx.paths.data, id).path);
          const mmproj = typeof body.mmprojUploadId === "string" ? readStagedUpload(ctx.paths.data, body.mmprojUploadId).path : undefined;
          const asset = await mgr.commitImport({ filePaths: paths, ...(typeof body.title === "string" ? { title: body.title } : {}), ...(mmproj ? { associateMmproj: mmproj } : {}) });
          for (const id of ids) removeStagedUpload(ctx.paths.data, id);
          if (typeof body.mmprojUploadId === "string") removeStagedUpload(ctx.paths.data, body.mmprojUploadId);
          return json({ asset, state: mgr.state() });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/imports/cancel",
      surface: "models",
      access: "edit",
      async handler(req) {
        const body = await bodyOf(req);
        if (typeof body.uploadId === "string") removeStagedUpload(ctx.paths.data, body.uploadId);
        return json({ ok: true });
      },
    });

    ctx.http({
      method: "POST",
      path: "/paths/register",
      surface: "models",
      access: "edit",
      async handler(req) {
        try {
          const body = await bodyOf(req);
          if (typeof body.path !== "string") return fail("укажите путь на машине Sinty");
          const asset = mgr.registerExistingPath(body.path, typeof body.title === "string" ? body.title : undefined, typeof body.mmprojPath === "string" ? body.mmprojPath : undefined);
          return json({ asset, state: mgr.state() });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/profiles",
      surface: "models",
      access: "edit",
      async handler(req) {
        try {
          const body = await bodyOf(req);
          const profile = mgr.saveProfile(body);
          return json({ profile, state: mgr.state() });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/assets/delete",
      surface: "models",
      access: "edit",
      async handler(req) {
        try {
          const body = await bodyOf(req);
          if (typeof body.id !== "string") return fail("нужен id");
          mgr.deleteAsset(body.id, body.confirm === true);
          return json(mgr.state());
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/instance/start",
      surface: "models",
      access: "edit",
      async handler(req) {
        try {
          const body = await bodyOf(req);
          if (typeof body.profileId !== "string") return fail("нужен профиль");
          const instance = await mgr.start(body.profileId);
          return json({ instance, provider: mgr.providerSnapshot(), state: mgr.state() });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/instance/stop",
      surface: "models",
      access: "edit",
      async handler(req) {
        try {
          const body = await bodyOf(req);
          if (body.confirm !== true) return fail("нужно подтверждение остановки");
          await mgr.stop(true);
          return json(mgr.state());
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/catalog/bind",
      surface: "models",
      access: "edit",
      async handler(req) {
        try {
          const body = await bodyOf(req);
          if (typeof body.profileId !== "string") return fail("нужен профиль");
          const bound = mgr.bindCatalog(body.profileId, typeof body.alias === "string" ? body.alias : undefined);
          const live = mgr.providerSnapshot();
          return json({
            ...bound,
            provider: live ?? bound.provider,
            state: mgr.state(),
            needsCatalogBind: true,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    });

    ctx.http({
      method: "POST",
      path: "/catalog/unbind",
      surface: "models",
      access: "edit",
      async handler(req) {
        try {
          const body = await bodyOf(req);
          if (typeof body.route !== "string") return fail("нужен маршрут");
          mgr.unbindCatalog(body.route);
          return json({ route: body.route, needsCatalogUnbind: true, state: mgr.state() });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    });

  },
  async dispose() {
    const current = manager;
    manager = undefined;
    await current?.dispose();
  },
});
