import { randomBytes } from "node:crypto";
import type { SintyConfig } from "./config.js";
import { SecretStore } from "./secrets.js";

/** A login token for the HTTP API and the Web UI: `snt_` + 24 random bytes, base64url (192 bits). */
export function newApiToken(): string {
  return `snt_${randomBytes(24).toString("base64url")}`;
}

export class TokenRotationError extends Error {
  constructor(
    readonly code: "token_literal" | "token_env",
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/** The secret name `server.token` points at (`secret://api.token` → `api.token`), or undefined for a literal token. */
export function apiTokenSecretName(config: SintyConfig): string | undefined {
  const ref = config.server.token;
  return SecretStore.isRef(ref) ? ref.slice("secret://".length) : undefined;
}

/**
 * Replaces the login token with a new random one and returns it. The old one stops working at once in this process
 * and in a running server (the API resolves the token on every request and SecretStore re-reads secrets.json when it
 * changes). Refuses when the token is not a stored secret: a literal `server.token` in config.yaml or an
 * environment override `SINTY_SECRET_<NAME>` would win over the stored value.
 */
export function rotateApiToken(secrets: SecretStore, config: SintyConfig): string {
  const name = apiTokenSecretName(config);
  if (!name) throw new TokenRotationError("token_literal", "server.token in config.yaml is a literal value, not a secret", "Set server.token: secret://api.token in config.yaml, then rotate.");
  const env = `SINTY_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  if (process.env[env]) throw new TokenRotationError("token_env", `the login token comes from the environment variable ${env}`, `Change or unset ${env} instead.`);
  const token = newApiToken();
  secrets.set(name, token);
  return token;
}
