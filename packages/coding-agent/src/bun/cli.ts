#!/usr/bin/env node
import { getManagedRuntimeRoot } from "../runtime-bootstrap.ts";

if (getManagedRuntimeRoot(import.meta.url)) {
	throw new Error("Managed runtime generations require the standard Node.js bootstrap; Bun launch is unsupported");
}

const [{ registerBunOAuthFlows }, { APP_NAME }, { restoreSandboxEnv }] = await Promise.all([
	import("@earendil-works/pi-ai/bun-oauth"),
	import("../config.ts"),
	import("./restore-sandbox-env.ts"),
]);
process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
restoreSandboxEnv();
await import("./register-bedrock.ts");
await import("../cli.ts");
