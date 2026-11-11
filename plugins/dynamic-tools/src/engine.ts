import { createHash, randomBytes } from 'node:crypto';
import { z, ToolError, type ChatMessage, type ProviderRequest, type ProviderChunk, type ToolSchema } from '@sinty/sdk';
export const SEARCH = 'dynamic-tools__search', MARK = '__SINTY_DYNAMIC_TOOLS_V1:';
const name = z.string().min(1).max(300).regex(/^[A-Za-z0-9_.-]+$/);
export const settingsSchema = z.object({ enabled: z.boolean(), retention: z.enum(['chat', 'request']), pinned: z.array(name).max(4096) }).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = { enabled: false, retention: 'chat', pinned: ['fs.list', 'fs.read', 'skill.read'] };
type Chat = {
    active: string[];
    pending: string[];
    seen: Record<string, string[]>;
};
export type Stored = {
    settings: Settings;
    chats: Record<string, Chat>;
};
const storedSchema = z.object({ settings: settingsSchema, chats: z.record(z.string(), z.object({ active: z.array(name).max(10000), pending: z.array(name).max(10000), seen: z.record(z.string(), z.array(name).max(50)) })) });
export const readStored = (v: unknown): Stored => { const p = storedSchema.safeParse(v); return p.success ? p.data : { settings: { ...defaults, pinned: [...defaults.pinned] }, chats: {} }; };
const wire = (s: string) => s.replaceAll('.', '__');
// The host may shorten old tool-result bodies for a fallback. Keep role/call identity and all other messages bound.
const correlation = (messages: ChatMessage[]) => messages.map(m => m.role === 'tool' ? {...m, content: ''} : m);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const cloneTools = (ts: ToolSchema[]) => structuredClone(ts);
const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const aliases: Record<string, string[]> = { файл: ['file', 'fs'], файлы: ['file', 'fs'], читать: ['read'], прочитать: ['read'], папка: ['directory', 'list', 'fs'], поиск: ['search'], изображение: ['image', 'runninghub'], картинка: ['image', 'runninghub'], видео: ['video', 'runninghub'], аудио: ['audio', 'runninghub'], картин: ['image', 'runninghub'], изображ: ['image', 'runninghub'], генер: ['generate', 'image'], сгенер: ['generate', 'image'], память: ['memory'], навык: ['skill'], навыки: ['skill'], интернет: ['web'], страница: ['web', 'read'] };
export function searchTools(query: string, tools: ToolSchema[], pinned: Set<string>, limit: number): ToolSchema[] {
    const q = norm(query), words = [...new Set(q.split(' ').filter(Boolean).flatMap(w => [w, ...Object.entries(aliases).filter(([k]) => w === k || (k.length > 3 && w.startsWith(k))).flatMap(([, v]) => v)]))];
    return tools.filter(t => t.name !== SEARCH && !pinned.has(t.name)).map(t => { const n = norm(t.name), d = norm(t.description); const score = (n === q ? 1000 : 0) + (n.includes(q) ? 100 : 0) + words.reduce((v, w) => v + (n.includes(w) ? 12 : 0) + (d.includes(w) ? 2 : 0), 0); return { t, score }; }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name, 'en')).slice(0, limit).map(x => x.t);
}
type Ticket = {
    session: string;
    prefix: string;
    created: number;
    selection?: string[];
    pinned?: string[];
};
type Call = {
    session: string;
    catalog: ToolSchema[];
    ticket: string;
};
export type Measurement = {
    baseline: number;
    pinned: number;
    activated: number;
    sent: number;
    baselineBytes: number;
    sentBytes: number;
    mode: 'dynamic' | 'full';
    reason: string;
    at: number;
};
export class CatalogEngine {
    readonly tickets = new Map<string, Ticket>();
    readonly calls = new Map<string, Call>();
    readonly catalogs = new Map<string, ToolSchema[]>();
    readonly metrics: Measurement[] = [];
    constructor(public stored: Stored, private save: (value: Stored) => void = () => { }) { }
    settings() { return this.stored.settings; }
    configure(value: unknown) { const next = settingsSchema.parse(value); if (next.retention !== this.settings().retention)
        this.stored.chats = {}; this.stored.settings = { ...next, pinned: [...new Set(next.pinned)] }; this.save(this.stored); }
    private chat(id: string): Chat | undefined { if (!Object.hasOwn(this.stored.chats, id)) {
        if (Object.keys(this.stored.chats).length >= 2048)
            return;
        this.stored.chats[id] = { active: [], pending: [], seen: {} };
    } return this.stored.chats[id]; }
    context(session: string, messages: ChatMessage[]): ChatMessage[] {
        if (!this.settings().enabled)
            return messages;
        for (const [key, t] of this.tickets)
            if (Date.now() - t.created > 30 * 60 * 1000)
                this.tickets.delete(key);
        if (this.tickets.size >= 2048)
            return messages;
        const token = randomBytes(32).toString('hex');
        this.tickets.set(token, { session, prefix: digest(correlation(messages)), created: Date.now() });
        // Observation only: never inject private correlation metadata into ANY provider's prompt.
        return messages;
    }
    reset() { this.stored.chats = {}; this.save(this.stored); }
    prepare(req: ProviderRequest) {
        const fingerprint = this.settings().enabled ? digest(correlation(req.messages)) : undefined;
        const candidates = fingerprint ? [...this.tickets].filter(([,t]) => t.prefix === fingerprint && Date.now()-t.created < 30*60*1000) : [];
        const [token, ticket] = candidates.length === 1 ? candidates[0]! : [];
        const valid = !!ticket, clean = req;
        // Identical concurrent prompts are genuinely indistinguishable without a core API.
        // Bypass filtering, and invalidate stale discovery views rather than guessing a chat.
        if (candidates.length > 1) for (const [,candidate] of candidates) this.catalogs.delete(candidate.session);
        const hasSearch = req.tools.some(t => t.name === SEARCH), catalog = this.settings().enabled ? cloneTools(req.tools) : req.tools, pinned = new Set(this.settings().pinned.map(wire));
        pinned.add(SEARCH);
        let selection: string[] | undefined, reason = 'mode-off', effectivePins = pinned;
        if (valid) {
            const chat = this.chat(ticket!.session);
            if (chat) {
                this.catalogs.set(ticket!.session, catalog);
                const allowed = new Set(catalog.map(t => t.name));
                const active = chat.active.filter(n => allowed.has(n)), pending = chat.pending.filter(n => allowed.has(n));
                const changed = active.length !== chat.active.length || pending.length !== chat.pending.length;
                chat.active = active; chat.pending = pending;
                if (changed) this.save(this.stored);
            }
        }
        if (this.settings().enabled && valid && hasSearch) {
            const session = ticket!.session;
            const chat = this.chat(session);
            if (chat) {
                this.catalogs.set(session, catalog);
                const allowed = new Set(catalog.map(t => t.name));
                chat.active = chat.active.filter(n => allowed.has(n));
                chat.pending = chat.pending.filter(n => allowed.has(n));
                if (!ticket!.selection) {
                    const active = this.settings().retention === 'chat' ? chat.active : chat.pending;
                    ticket!.pinned = [...pinned];
                    ticket!.selection = [...new Set([...active, ...pinned])];
                    if (this.settings().retention === 'request') {
                        chat.pending = [];
                        this.save(this.stored);
                    }
                }
                selection = ticket!.selection.filter(n => allowed.has(n));
                effectivePins = new Set(ticket!.pinned);
                reason = 'selected';
            }
            else
                reason = 'state-capacity-full';
        }
        else if (this.settings().enabled)
            reason = !valid ? (candidates.length > 1 ? 'ambiguous-request-identity' : 'missing-request-identity') : 'discovery-not-in-agent-list';
        const selected = selection ? catalog.filter(t => selection!.includes(t.name)) : req.tools;
        const prepared: ProviderRequest = selection ? { ...clean, tools: selected } : clean;
        const measurement: Measurement = { baseline: req.tools.length, pinned: catalog.filter(t => effectivePins.has(t.name) && t.name !== SEARCH).length, activated: selection?.filter(n => !effectivePins.has(n)).length ?? 0, sent: selected.length, baselineBytes: Buffer.byteLength(JSON.stringify(req.tools)), sentBytes: Buffer.byteLength(JSON.stringify(selected)), mode: selection ? 'dynamic' : 'full', reason, at: Date.now() };
        this.metrics.push(measurement);
        if (this.metrics.length > 200)
            this.metrics.shift();
        return { request: prepared, token: valid ? token : undefined, ticket: valid ? ticket : undefined, catalog, dynamic: !!selection };
    }
    async *stream(req: ProviderRequest, delegate: (r: ProviderRequest) => AsyncIterable<ProviderChunk>): AsyncGenerator<ProviderChunk> {
        const plan = this.prepare(req);
        if (!plan.dynamic) {
            yield* delegate(plan.request);
            return;
        }
        const allowed = new Set(plan.request.tools.map(t => t.name)), calls: Extract<ProviderChunk, {
            type: 'tool_call';
        }>[] = [], ids = new Set<string>();
        let issue = false, done: Extract<ProviderChunk, {
            type: 'done';
        }> | undefined;
        for await (const chunk of delegate(plan.request)) {
            if (chunk.type === 'tool_call') {
                if (!allowed.has(chunk.name) || !chunk.id || ids.has(chunk.id))
                    issue = true;
                else {
                    ids.add(chunk.id);
                    calls.push(chunk);
                }
            }
            else if (chunk.type === 'done')
                done = chunk;
            else
                yield chunk;
        }
        if (issue) {
            yield { type: 'text', text: '\n\n[Sinty dynamic-tools: unexpected_tool_call. Tool calls were not executed.]' };
            yield { type: 'done', stopReason: 'stop', usage: done?.usage ?? { inputTokens: 0, outputTokens: 0 } };
            return;
        }
        for (const call of calls) {
            if (call.name === SEARCH && plan.ticket && plan.token) {
                const key = plan.ticket.session + '\0' + call.id;
                if (this.calls.has(key)) {
                    yield { type: 'text', text: '\n\n[Sinty dynamic-tools: ambiguous_search_identity. Tool calls were not executed.]' };
                    yield { type: 'done', stopReason: 'stop', usage: done?.usage ?? { inputTokens: 0, outputTokens: 0 } };
                    return;
                }
                if (this.calls.size >= 4096) {
                    yield { type: 'text', text: '\n\n[Sinty dynamic-tools: search_capacity. Tool calls were not executed.]' };
                    yield { type: 'done', stopReason: 'stop', usage: done?.usage ?? { inputTokens: 0, outputTokens: 0 } };
                    return;
                }
                this.calls.set(key, { session: plan.ticket.session, catalog: plan.catalog, ticket: plan.token });
            }
        }
        for (const call of calls)
            yield call;
        if (done)
            yield done;
    }
    search(query: string, limit: number, ctx: {
        sessionId: string;
        callId: string;
        idempotencyKey: string;
    }) {
        if (!this.settings().enabled)
            return { content: { matches: [], nextRequest: false, note: 'Dynamic mode is OFF. The original permitted tool catalog is already advertised; no permissions changed.' } };
        const key = ctx.sessionId + '\0' + ctx.callId, call = this.calls.get(key), current = this.catalogs.get(ctx.sessionId), chat = this.chat(ctx.sessionId);
        if (!chat)
            throw new ToolError('catalog_capacity', 'Chat activation capacity is full; reset activation from settings.');
        const previous = Object.hasOwn(chat.seen, ctx.idempotencyKey) ? chat.seen[ctx.idempotencyKey] : undefined;
        // Replayed successful searches never replenish one-request activation, including after restart.
        if (previous) {
            const matches = (current ?? []).filter(t => previous.includes(t.name));
            this.calls.delete(key);
            return { content: { matches: matches.map(t => ({ name: t.name.replaceAll('__', '.'), description: t.description.slice(0, 400) })), nextRequest: false, replayed: true, note: 'Already processed; activation was not repeated. Current request permissions still apply.' } };
        }
        if (!call || !current)
            throw new ToolError('catalog_unavailable', 'No verified request catalog for this search. No permissions were changed.');
        const allowed = new Set(current.map(t => t.name)), catalog = call.catalog.filter(t => allowed.has(t.name)), pins = new Set(this.settings().pinned.map(wire));
        if (Object.keys(chat.seen).length >= 4096)
            throw new ToolError('catalog_capacity', 'Search replay ledger is full; reset activation from settings.');
        const matches = searchTools(query, catalog, pins, limit), names = matches.map(t => t.name);
        chat.seen[ctx.idempotencyKey] = names;
        if (this.settings().retention === 'chat')
            chat.active = [...new Set([...chat.active, ...names])];
        else
            chat.pending = [...new Set([...chat.pending, ...names])];
        this.save(this.stored);
        this.calls.delete(key);
        return { content: { matches: matches.map(t => ({ name: t.name.replaceAll('__', '.'), description: t.description.slice(0, 400) })), retention: this.settings().retention, nextRequest: true, note: 'Real schemas will be advertised on the next model request. This search executes no tools and grants no permissions.' } };
    }
}
