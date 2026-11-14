import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cliPath = join(import.meta.dirname, "../dist/bundle/cli.js");
const sseResponse = [
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
	'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

type RequestSummary = { method: string; path: string; sessionHeaderPresent: boolean };

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ["ignore", "ignore", "ignore"] });
		const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolve(code ?? -1);
		});
	});
}

function respond(request: IncomingMessage, response: ServerResponse, requests: RequestSummary[], failFirst: boolean) {
	requests.push({
		method: request.method ?? "",
		path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
		sessionHeaderPresent: request.headers["x-opencode-session"] !== undefined,
	});
	request.resume();
	request.once("end", () => {
		if (failFirst && requests.length === 1) {
			response.writeHead(500, { "content-type": "application/json" });
			response.end('{"error":{"type":"api_error","message":"retry"}}');
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.end(sseResponse);
	});
}

const server = createServer();
const requests: RequestSummary[] = [];
server.on("request", (request, response) => respond(request, response, requests, true));

describe("OpenCode session header CLI integration", () => {
	it.each([
		["opencode-go", "claude-haiku-5-5"],
		["opencode", "claude-fable-5"],
	])("sends session routing on POST /v1/messages and retries consistently for %s", async (provider, model) => {
		requests.length = 0;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port");

		const agentDir = await mkdtemp(join(tmpdir(), "pi-opencode-cli-"));
		try {
			await writeFile(
				join(agentDir, "models.json"),
				JSON.stringify({ providers: { [provider]: { baseUrl: `http://127.0.0.1:${address.port}` } } }),
			);
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				OPENCODE_API_KEY: "fake-local-test-key",
			};
			for (const key of Object.keys(env)) {
				if (key !== "OPENCODE_API_KEY" && /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY)/i.test(key)) {
					delete env[key];
				}
			}
			expect(
				await runCli(["-p", "local mock integration", "--model", `${provider}/${model}`, "--no-tools"], env),
			).toBe(0);
			expect(requests).toHaveLength(2);
			expect(requests).toEqual([
				{ method: "POST", path: "/v1/messages", sessionHeaderPresent: true },
				{ method: "POST", path: "/v1/messages", sessionHeaderPresent: true },
			]);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
