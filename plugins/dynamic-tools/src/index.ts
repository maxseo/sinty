import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { definePlugin, z, type ProviderDefinition, type PluginContext } from '@sinty/sdk';
import { CatalogEngine, readStored, settingsSchema, type Stored } from './engine.js';
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
export default definePlugin({ name: 'dynamic-tools', async setup(ctx) {
        mkdirSync(ctx.paths.data, { recursive: true });
        const file = join(ctx.paths.data, 'state.json');
        let initial: unknown;
        try {
            initial = JSON.parse(readFileSync(file, 'utf8'));
        }
        catch {
            initial = undefined;
        }
        const save = (s: Stored) => { const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(s)); renameSync(tmp, file); };
        const engine = new CatalogEngine(readStored(initial), save);
        ctx.context('request-identity', async (input) => engine.context(input.sessionId, input.messages), { order: 10000 });
        ctx.tool({ name: 'dynamic-tools.search', description: 'Search the tools available in THIS request when basic tools do not cover the task. Use a tool/plugin name or Russian/English description. Selected tools gain their true schemas on the next model request; this search never executes them. Pinned tools are already visible.', input: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(12).default(5) }), sideEffects: 'none', idempotent: true, async run(args, c) { return engine.search(args.query, args.limit, c); } });
        // Compose the shipped production adapters, including the installed RH catalog-compatible contract.
        // No separate model call, route rewrite, guessed command proxy, or copy of adapter implementation.
        for (const name of ['provider-openai-compat', 'provider-anthropic', 'provider-openai-responses']) {
            const module = await import(pathToFileURL(resolve(ctx.paths.plugin, '..', name, 'dist/index.js')).href) as {
                default: {
                    setup(c: PluginContext): void | Promise<void>;
                };
            };
            await module.default.setup({ ...ctx, provider(def: ProviderDefinition) { ctx.provider({ ...def, stream(req) { return engine.stream(req, r => def.stream(r)); } }); } });
        }
        ctx.http({ method: 'GET', path: '/status', surface: 'settings', access: 'view', handler: () => json({ settings: engine.settings(), metrics: engine.metrics.slice(-20), registeredProtocols: ['openai-compat', 'anthropic', 'openai-responses'], observed: engine.metrics.length > 0, notice: 'Own mode switch only. Standard lifecycle OFF/ON loses provider priority; disable during generation can interrupt it. Registry metadata is not permission.' }) });
        ctx.http({ method: 'POST', path: '/settings', surface: 'settings', access: 'edit', async handler(req) { const input = await req.json().catch(() => null); const parsed = settingsSchema.safeParse(input); if (!parsed.success)
                return json({ error: { code: 'bad_request', message: 'Expected enabled, retention(chat/request), pinned tool names only' } }, 400); engine.configure(parsed.data); return json({ ok: true, settings: engine.settings() }); } });
        ctx.http({ method: 'POST', path: '/reset', surface: 'settings', access: 'edit', handler: () => { engine.reset(); return json({ ok: true }); } });
        ctx.http({ method: 'GET', path: '/tab', public: true, surface: 'settings', handler: () => {
                const location = join(ctx.paths.plugin, 'public', 'index.html');
                const html = existsSync(location) ? readFileSync(location, 'utf8') : '<!doctype html><p>Dynamic tools UI is not built.</p>';
                return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'", 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
            } });
    } });
