/** Name-only hypotheses: complete-name metadata OR genuine delta fragments. Never touches arguments. */
export class CompatibleToolNames {
  private readonly names: Set<string>;
  private readonly prefixes = new Set<string>();
  readonly valid: boolean;
  constructor(names: string[]) {
    this.names = new Set(names);
    this.valid = this.names.size === names.length && names.every(name => typeof name === "string" && name.length > 0);
    if (this.valid) for (const name of names) for (let i = 1; i <= name.length; i++) this.prefixes.add(name.slice(0, i));
  }
  advance(previous: ReadonlySet<string>, field: string): Set<string> {
    const next = new Set<string>();
    for (const prefix of previous) {
      const appended = prefix + field;
      if (this.prefixes.has(appended)) next.add(appended);
      // Equality is meaningful only for a complete advertised name, never an arbitrary partial fragment.
      if (prefix === field && this.names.has(prefix)) next.add(prefix);
    }
    return next;
  }
  resolve(candidates: ReadonlySet<string>): { name?: string; issue?: string } {
    // Even an incomplete alternate prefix is ambiguous: never silently select a shorter allowed command.
    if (candidates.size > 1) return { issue: "ambiguous_tool_name" };
    const name = candidates.values().next().value;
    return name && this.names.has(name) ? { name } : { issue: "incomplete_or_unknown_tool_name" };
  }
}
