import { describe } from "vitest";

type SuiteCallback = () => void;
type LiveProviderDescribe = {
	(name: string, callback: SuiteCallback): void;
	skipIf(condition: boolean): (name: string, callback: SuiteCallback) => void;
};

const liveProviderOptIn = process.env.PI_AI_TEST_LIVE_PROVIDER === "1";
const optInReason =
	"skipped: set PI_AI_TEST_LIVE_PROVIDER=1 to run live provider tests; credentials and provider charges may apply";

function registerLiveProviderSuite(name: string, callback: SuiteCallback, skipForMissingCredentials = false): void {
	const skipped = !liveProviderOptIn || skipForMissingCredentials;
	const suffix = !liveProviderOptIn
		? ` (${optInReason})`
		: skipForMissingCredentials
			? " (skipped: required provider credentials are unavailable)"
			: "";

	(skipped ? describe.skip : describe)(`${name}${suffix}`, callback);
}

/**
 * Registers a provider test suite that may make paid, account-specific network
 * requests. It is skipped by default; set PI_AI_TEST_LIVE_PROVIDER=1 to opt in.
 */
export const liveProviderDescribe: LiveProviderDescribe = Object.assign(
	(name: string, callback: SuiteCallback) => registerLiveProviderSuite(name, callback),
	{
		skipIf: (condition: boolean) => (name: string, callback: SuiteCallback) =>
			registerLiveProviderSuite(name, callback, condition),
	},
);
