/** Deliberately restricted metadata capability. Never forwards endpoints, auth, schemas, configs or histories. */
export interface ToolMetadata {
    name: string;
    description: string;
    plugin: string;
}
export const DYNAMIC_CATALOG_OP = 'dynamic-tools.catalog';
export function catalogMessageAllowed(plugin: string, tab: string, source: MessageEventSource | null, expected: Window | null, origin: string, nonce: unknown, wanted: string): boolean { return plugin === 'dynamic-tools' && tab === 'settings' && !!expected && source === expected && origin === 'null' && typeof nonce === 'string' && nonce === wanted; }
function clean(value: unknown, max: number) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : ''; }
export function metadataOnly(agent: unknown, plugins: unknown): ToolMetadata[] {
    const a = agent && typeof agent === 'object' ? agent as Record<string, unknown> : {};
    const p = plugins && typeof plugins === 'object' ? plugins as Record<string, unknown> : {};
    const rows = Array.isArray(p.plugins) ? p.plugins : [], owners = new Map<string, string>();
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object')
            continue;
        const row = raw as Record<string, unknown>, owner = clean(row.name, 100);
        if (!owner || !Array.isArray(row.tools))
            continue;
        for (const t of row.tools) {
            const name = typeof t === 'string' ? t : t && typeof t === 'object' ? (t as Record<string, unknown>).name : undefined;
            if (typeof name === 'string')
                if (!owners.has(name.replaceAll('.', '__'))) owners.set(name.replaceAll('.', '__'), owner);
        }
    }
    if (!Array.isArray(a.tools))
        return [];
    const result: ToolMetadata[] = [];
    for (const t of a.tools) {
        if (!t || typeof t !== 'object')
            continue;
        const tool = t as Record<string, unknown>, name = clean(tool.name, 300);
        if (!name || !/^[A-Za-z0-9_.-]+$/.test(name))
            continue;
        result.push({ name: name.replaceAll('__', '.'), description: clean(tool.description, 1000), plugin: owners.get(name.replaceAll('.', '__')) ?? 'Встроенные' });
        if (result.length >= 10000)
            break;
    }
    return result.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name));
}
