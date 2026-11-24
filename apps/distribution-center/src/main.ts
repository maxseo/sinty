import { readFileSync } from "node:fs";
import { createDistributionCenter } from "./center.ts";
const dataDir = process.env.CENTER_DATA_DIR, signingKeyFile = process.env.CENTER_SIGNING_KEY_FILE, publicBaseUrl = process.env.CENTER_PUBLIC_ORIGIN;
if (!dataDir || !signingKeyFile || !publicBaseUrl)
    throw Error("CENTER_DATA_DIR, CENTER_SIGNING_KEY_FILE and CENTER_PUBLIC_ORIGIN are required; setup does not generate production credentials");
const app = createDistributionCenter({...(process.env.CENTER_MAX_HARNESS_ARTIFACT_BYTES?{maxHarnessArtifactBytes:Number(process.env.CENTER_MAX_HARNESS_ARTIFACT_BYTES)}:{}), dataDir, signingKeyFile, publicBaseUrl, ...(process.env.CENTER_BOOTSTRAP_SECRET_FILE ? { bootstrapSecret: readFileSync(process.env.CENTER_BOOTSTRAP_SECRET_FILE, "utf8").trim() } : {}) });
const port = Number(process.env.PORT ?? 3198);
app.server.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log("Distribution center listening on configured local interface"));
for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => { void app.close().then(() => process.exit(0)); });
