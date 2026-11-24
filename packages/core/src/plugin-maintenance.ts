export class PluginMaintenanceGate {
    private owners = new Map<string, symbol>();
    blocked(name: string, token?: symbol): boolean { return this.owners.has(name) && this.owners.get(name) !== token; }
    async acquire(name: string, count: () => number, timeoutMs = 10000): Promise<{
        token: symbol;
        release: () => void;
    }> { if (this.owners.has(name))
        throw Object.assign(Error("Plugin already in maintenance"), { code: "plugin_maintenance" }); const token = Symbol(name); this.owners.set(name, token); const release = () => { if (this.owners.get(name) === token)
        this.owners.delete(name); }; try {
        const until = Date.now() + Math.min(Math.max(timeoutMs, 0), 30000);
        while (count() > 0) {
            if (Date.now() >= until)
                throw Object.assign(Error("Plugin is busy; update did not stop running work"), { code: "plugin_busy" });
            await new Promise(r => setTimeout(r, 20));
        }
        return { token, release };
    }
    catch (e) {
        release();
        throw e;
    } }
}
