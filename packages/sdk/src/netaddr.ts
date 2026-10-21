/**
 * Address classification for the core's public-internet guard (`ctx.net.public`). Pure functions, no I/O.
 * The core uses these after every DNS lookup and redirect; plugins may use them to hide obviously private links.
 * The decision that counts is always the core's: a plugin cannot widen it.
 */

/** Why an address is not public internet, or `undefined` when it is. */
export type AddressClass =
  | "unspecified"
  | "loopback"
  | "private"
  | "shared"
  | "link-local"
  | "multicast"
  | "reserved"
  | "documentation"
  | "unique-local"
  | "site-local"
  | "teredo"
  | "nat64-local"
  | "invalid";

const V4: [number, number, number, number, number, AddressClass][] = [
  [0, 0, 0, 0, 8, "unspecified"],
  [10, 0, 0, 0, 8, "private"],
  [100, 64, 0, 0, 10, "shared"], // CGNAT, RFC 6598
  [127, 0, 0, 0, 8, "loopback"],
  [169, 254, 0, 0, 16, "link-local"], // cloud metadata 169.254.169.254 lives here
  [172, 16, 0, 0, 12, "private"],
  [192, 0, 0, 0, 24, "reserved"], // IETF protocol assignments
  [192, 0, 2, 0, 24, "documentation"],
  [192, 88, 99, 0, 24, "reserved"], // 6to4 relay anycast
  [192, 168, 0, 0, 16, "private"],
  [198, 51, 100, 0, 24, "documentation"],
  [203, 0, 113, 0, 24, "documentation"],
  [224, 0, 0, 0, 4, "multicast"],
  [240, 0, 0, 0, 4, "reserved"], // includes 255.255.255.255
  // 198.18.0.0/15 (benchmarking) is NOT blocked: "fake-ip" DNS of Clash, sing-box and similar TUN proxies answers
  // every public name with an address from it, and the proxy then connects to the real host.
];

/** Strict dotted-quad IPv4: four decimal parts 0-255, no leading zeros. */
export function parseIPv4(s: string): [number, number, number, number] | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** IPv6 to 16 bytes. Accepts `::`, an embedded IPv4 tail, brackets and a zone id (`fe80::1%eth0`). */
export function parseIPv6(input: string): number[] | undefined {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return undefined;
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return undefined;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const group = (h: string): number[] | undefined => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = group(halves[0]!);
  const rest = halves.length === 2 ? group(halves[1]!) : [];
  if (!head || !rest) return undefined;
  if (halves.length === 2 && head.length + rest.length > 7) return undefined;
  const words = halves.length === 2 ? [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest] : head;
  if (words.length !== 8) return undefined;
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

function v4Class(b: readonly number[]): AddressClass | undefined {
  const n = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  for (const [a, c, d, e, bits, cls] of V4) {
    const base = ((a << 24) | (c << 16) | (d << 8) | e) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === base) return cls;
  }
  return undefined;
}

function v6Class(b: readonly number[]): AddressClass | undefined {
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return "unspecified";
  if (zero(0, 15) && b[15] === 1) return "loopback";
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (deprecated compatible) and 64:ff9b::a.b.c.d (NAT64) carry an IPv4 address.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Class(b.slice(12));
  if (zero(0, 12)) return v4Class(b.slice(12)) ?? "reserved";
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 12)) return v4Class(b.slice(12));
    if (b[4] === 0x00 && b[5] === 0x01) return "nat64-local"; // 64:ff9b:1::/48
  }
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return "reserved"; // 100::/64 discard
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "teredo"; // 2001::/32 embeds a client address
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation";
  if (b[0] === 0x20 && b[1] === 0x02) return v4Class(b.slice(2, 6)); // 6to4 2002:a.b.c.d::/48
  if ((b[0]! & 0xfe) === 0xfc) return "unique-local"; // fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "link-local"; // fe80::/10
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return "site-local"; // fec0::/10
  if (b[0] === 0xff) return "multicast";
  return undefined;
}

/**
 * Classifies an IP literal. Returns `undefined` for a public address, the reason otherwise; a string that is not an
 * IP literal returns `"invalid"`.
 */
export function classifyAddress(ip: string): AddressClass | undefined {
  const s = ip.trim();
  const v4 = parseIPv4(s);
  if (v4) return v4Class(v4);
  const v6 = parseIPv6(s);
  if (v6) return v6Class(v6);
  return "invalid";
}

/** True for anything that is not a public internet address (loopback, RFC 1918, link-local, CGNAT, ULA, mapped forms, ...). */
export function isPrivateAddress(ip: string): boolean {
  return classifyAddress(ip) !== undefined;
}

/** `true` when the string is an IPv4 or IPv6 literal (brackets allowed). */
export function isIpLiteral(s: string): boolean {
  return parseIPv4(s.trim()) !== undefined || parseIPv6(s) !== undefined;
}

/** Host names that never mean the public internet, whatever DNS says. */
export function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa") || h === "";
}
