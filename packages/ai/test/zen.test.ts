import { describe, expect, it } from "vitest";
import { complete } from "../src/compat.ts";
import { MODELS } from "../src/models.generated.ts";
import type { Model } from "../src/types.ts";

// Live-API smoke suite. OPENCODE_API_KEY alone is not enough: this environment
// held a key whose workspace access was revoked (403 permission_error on every
// model), failing the whole package run. Require an explicit opt-in so the
// suite runs only where access is known-good.
describe.skipIf(!process.env.OPENCODE_API_KEY || !process.env.OPENCODE_SMOKE)("OpenCode Models Smoke Test", () => {
	const providers = [
		{ key: "opencode", label: "OpenCode Zen" },
		{ key: "opencode-go", label: "OpenCode Go" },
	] as const;

	providers.forEach(({ key, label }) => {
		const providerModels = Object.values(MODELS[key]);
		providerModels.forEach((model) => {
			it(`${label}: ${model.id}`, async () => {
				const response = await complete(model as Model<any>, {
					messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
				});

				expect(response.content).toBeTruthy();
				expect(response.stopReason).toBe("stop");
			}, 60000);
		});
	});
});
