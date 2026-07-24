import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	configHash,
	convertMcpContent,
	expandVariables,
	limitToolOutput,
	McpClient,
	mcpPromptCommandName,
	mcpToolName,
	mergeServerScopes,
	normalizeServerConfig,
	parseAddArgs,
	parseMcpDocument,
	sanitizeName,
	SseParser,
	StdioTransport,
	tokenize,
	toolParametersSchema,
	type McpStdioConfig,
	type McpRemoteConfig,
} from "../extensions/mcp-core.ts";
import mcpExtension, {
	promptMessagesToText,
	readApprovalStore,
	resolveMcpHarnessConfig,
	storedApproval,
	withApproval,
} from "../extensions/mcp.ts";
import { classifyCustomTool } from "../extensions/policy-rules.ts";

/* ------------------------------------------------------------------ *
 * Environment variable expansion
 * ------------------------------------------------------------------ */

test("expandVariables handles ${VAR}, ${VAR:-default}, and missing vars", () => {
	const env = { API_KEY: "secret", EMPTY: "" } as NodeJS.ProcessEnv;
	assert.deepEqual(expandVariables("Bearer ${API_KEY}", env), { value: "Bearer secret", missing: [] });
	assert.deepEqual(expandVariables("${MISSING:-fallback}/x", env), { value: "fallback/x", missing: [] });
	assert.deepEqual(expandVariables("${EMPTY}", env), { value: "", missing: [] });
	const missing = expandVariables("${NOPE}", env);
	assert.equal(missing.value, "${NOPE}");
	assert.deepEqual(missing.missing, ["NOPE"]);
});

/* ------------------------------------------------------------------ *
 * Config normalization (Claude Code parity)
 * ------------------------------------------------------------------ */

test("normalizeServerConfig infers stdio from command", () => {
	const result = normalizeServerConfig("db", { command: "npx", args: ["-y", "server"], env: { KEY: "${K:-v}" } }, {} as NodeJS.ProcessEnv);
	assert.equal(result.error, undefined);
	const config = result.config as McpStdioConfig;
	assert.equal(config.type, "stdio");
	assert.equal(config.command, "npx");
	assert.deepEqual(config.args, ["-y", "server"]);
	assert.equal(config.env.KEY, "v");
});

test("normalizeServerConfig rejects url without type (Claude Code parity)", () => {
	const result = normalizeServerConfig("api", { url: "https://example.com/mcp" });
	assert.match(result.error ?? "", /has a "url" but no "type"/);
});

test("normalizeServerConfig accepts streamable-http alias and expands headers", () => {
	const env = { TOKEN: "t0k" } as NodeJS.ProcessEnv;
	const result = normalizeServerConfig("api", {
		type: "streamable-http",
		url: "https://example.com/mcp",
		headers: { Authorization: "Bearer ${TOKEN}" },
	}, env);
	const config = result.config as McpRemoteConfig;
	assert.equal(config.type, "http");
	assert.equal(config.headers.Authorization, "Bearer t0k");
});

test("normalizeServerConfig rejects ws and unknown transports", () => {
	assert.match(normalizeServerConfig("a", { type: "ws", url: "wss://x" }).error ?? "", /WebSocket/);
	assert.match(normalizeServerConfig("b", { type: "carrier-pigeon", url: "https://x" }).error ?? "", /unknown transport/);
});

test("normalizeServerConfig ignores sub-second timeouts and keeps valid ones", () => {
	const ignored = normalizeServerConfig("a", { command: "x", timeout: 500 });
	assert.equal(ignored.config?.timeout, undefined);
	assert.equal(ignored.warnings.length, 1);
	const kept = normalizeServerConfig("b", { command: "x", timeout: 5_000 });
	assert.equal(kept.config?.timeout, 5_000);
});

test("normalizeServerConfig warns on unset env vars and keeps literal", () => {
	const result = normalizeServerConfig("a", { type: "http", url: "https://example.com/${MISSING_VAR}" }, {} as NodeJS.ProcessEnv);
	assert.equal((result.config as McpRemoteConfig).url, "https://example.com/${MISSING_VAR}");
	assert.match(result.warnings[0] ?? "", /MISSING_VAR/);
});

test("parseMcpDocument reads mcpServers and reports bad JSON", () => {
	assert.deepEqual(parseMcpDocument(`{"mcpServers":{"a":{"command":"x"}}}`).servers, { a: { command: "x" } });
	assert.match(parseMcpDocument("{oops").error ?? "", /invalid JSON/);
	assert.deepEqual(parseMcpDocument("{}").servers, {});
});

test("mergeServerScopes applies local > project > user precedence", () => {
	const { entries } = mergeServerScopes([
		{ scope: "user", servers: { a: { command: "user-a" }, b: { command: "user-b" } } },
		{ scope: "project", servers: { a: { command: "project-a" }, c: { command: "project-c" } } },
		{ scope: "local", servers: { a: { command: "local-a" } } },
	], {} as NodeJS.ProcessEnv);
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	assert.equal((byName.get("a")?.config as McpStdioConfig).command, "local-a");
	assert.equal(byName.get("a")?.scope, "local");
	assert.equal((byName.get("b")?.config as McpStdioConfig).command, "user-b");
	assert.equal(byName.get("c")?.scope, "project");
});

test("mergeServerScopes surfaces invalid entries as warnings", () => {
	const { entries, warnings } = mergeServerScopes([
		{ scope: "user", servers: { bad: { url: "https://x" }, good: { command: "ok" } } },
	], {} as NodeJS.ProcessEnv);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.name, "good");
	assert.equal(warnings.length, 1);
});

test("configHash is stable under key ordering", () => {
	assert.equal(configHash({ a: 1, b: [1, 2], c: { d: "x" } }), configHash({ c: { d: "x" }, b: [1, 2], a: 1 }));
	assert.notEqual(configHash({ a: 1 }), configHash({ a: 2 }));
});

/* ------------------------------------------------------------------ *
 * Naming, output limits, content conversion
 * ------------------------------------------------------------------ */

test("mcpToolName follows the mcp__server__tool convention", () => {
	assert.equal(mcpToolName("github", "get_issue"), "mcp__github__get_issue");
	assert.equal(mcpToolName("my server!", "do.thing"), "mcp__my_server___do_thing");
	assert.equal(sanitizeName("a-b_C9"), "a-b_C9");
	assert.equal(mcpPromptCommandName("github", "pr review"), "mcp__github__pr_review");
});

test("limitToolOutput truncates by estimated tokens", () => {
	const small = limitToolOutput("hello", 25_000);
	assert.equal(small.truncated, false);
	const big = limitToolOutput("x".repeat(1_000), 100);
	assert.equal(big.truncated, true);
	assert.ok(big.text.startsWith("x".repeat(400)));
	assert.match(big.text, /MAX_MCP_OUTPUT_TOKENS/);
	assert.equal(big.estimatedTokens, 250);
});

test("convertMcpContent maps MCP content blocks to pi tool content", () => {
	const converted = convertMcpContent([
		{ type: "text", text: "hi" },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
		{ type: "resource", resource: { uri: "file:///a.txt", text: "body" } },
		{ type: "resource_link", uri: "res://x", name: "X" },
	]);
	assert.deepEqual(converted[0], { type: "text", text: "hi" });
	assert.deepEqual(converted[1], { type: "image", data: "AAAA", mimeType: "image/png" });
	assert.match((converted[2] as { text: string }).text, /file:\/\/\/a\.txt/);
	assert.match((converted[3] as { text: string }).text, /resource link/);
});

test("convertMcpContent falls back to structuredContent, then placeholder", () => {
	const structured = convertMcpContent([], { answer: 42 });
	assert.match((structured[0] as { text: string }).text, /"answer": 42/);
	assert.deepEqual(convertMcpContent([], undefined), [{ type: "text", text: "(no content)" }]);
});

test("toolParametersSchema guarantees an object schema", () => {
	assert.deepEqual(toolParametersSchema(undefined), { type: "object", properties: {} });
	assert.deepEqual(toolParametersSchema({ properties: { a: { type: "string" } } }), { type: "object", properties: { a: { type: "string" } } });
	const passthrough = toolParametersSchema({ type: "object", properties: { x: { type: "number" } }, required: ["x"] });
	assert.deepEqual((passthrough as { required: string[] }).required, ["x"]);
});

/* ------------------------------------------------------------------ *
 * SSE parsing
 * ------------------------------------------------------------------ */

test("SseParser handles chunk boundaries, CRLF, multi-line data, and comments", () => {
	const parser = new SseParser();
	assert.deepEqual(parser.push("event: endpoint\r\nda"), []);
	const first = parser.push("ta: /messages?id=1\r\n\r\n");
	assert.deepEqual(first, [{ event: "endpoint", data: "/messages?id=1", id: undefined }]);
	const second = parser.push(": keepalive\ndata: line1\ndata: line2\n\nid: 7\ndata: {}\n\n");
	assert.equal(second.length, 2);
	assert.deepEqual(second[0], { event: "message", data: "line1\nline2", id: undefined });
	assert.deepEqual(second[1], { event: "message", data: "{}", id: "7" });
});

/* ------------------------------------------------------------------ *
 * /mcp add argument parsing
 * ------------------------------------------------------------------ */

test("tokenize splits shell-style tokens with quotes", () => {
	assert.deepEqual(tokenize(`add --header "X-Key: a b" name https://x`), ["add", "--header", "X-Key: a b", "name", "https://x"]);
	assert.deepEqual(tokenize(""), []);
	assert.deepEqual(tokenize("a  'b c'"), ["a", "b c"]);
});

test("parseAddArgs parses remote servers", () => {
	const parsed = parseAddArgs(tokenize(`--transport http --scope user notion https://mcp.notion.com/mcp --header "Authorization: Bearer t"`));
	assert.equal(parsed.error, undefined);
	assert.equal(parsed.name, "notion");
	assert.equal(parsed.scope, "user");
	assert.deepEqual(parsed.raw, { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer t" } });
});

test("parseAddArgs infers http from URL and defaults to local scope", () => {
	const parsed = parseAddArgs(tokenize("stripe https://mcp.stripe.com"));
	assert.equal(parsed.scope, "local");
	assert.deepEqual(parsed.raw, { type: "http", url: "https://mcp.stripe.com" });
});

test("parseAddArgs parses stdio servers after --", () => {
	const parsed = parseAddArgs(tokenize("--env AIRTABLE_API_KEY=k airtable -- npx -y airtable-mcp-server --verbose"));
	assert.equal(parsed.error, undefined);
	assert.deepEqual(parsed.raw, {
		type: "stdio",
		command: "npx",
		args: ["-y", "airtable-mcp-server", "--verbose"],
		env: { AIRTABLE_API_KEY: "k" },
	});
});

test("parseAddArgs rejects bad input", () => {
	assert.match(parseAddArgs(tokenize("")).error ?? "", /name is required/);
	assert.match(parseAddArgs(tokenize("bad/name https://x")).error ?? "", /letters, numbers/);
	assert.match(parseAddArgs(tokenize("--scope global x https://y")).error ?? "", /invalid scope/);
	assert.match(parseAddArgs(tokenize("--env NOVALUE x -- cmd")).error ?? "", /--env/);
	assert.match(parseAddArgs(tokenize("name localhost:3000")).error ?? "", /cannot infer transport/);
	assert.match(parseAddArgs(tokenize("--transport http name -- cmd")).error ?? "", /does not take a command/);
});

/* ------------------------------------------------------------------ *
 * Extension-level helpers
 * ------------------------------------------------------------------ */

test("promptMessagesToText flattens prompt messages", () => {
	const text = promptMessagesToText([
		{ role: "user", content: { type: "text", text: "Review this PR" } },
		{ role: "assistant", content: [{ type: "text", text: "Sure." }] },
		{ role: "user", content: { type: "resource", resource: { uri: "x", text: "context" } } },
	]);
	assert.equal(text, "Review this PR\n\n[assistant]\nSure.\n\ncontext");
	assert.equal(promptMessagesToText(undefined), "");
});

test("approval store helpers pin approvals to config hashes", () => {
	const hash = configHash({ command: "x" });
	let store = withApproval({}, "/proj", "srv", hash, "approved");
	assert.equal(storedApproval(store, "/proj", "srv", hash), "approved");
	assert.equal(storedApproval(store, "/proj", "srv", configHash({ command: "changed" })), undefined);
	assert.equal(storedApproval(store, "/other", "srv", hash), undefined);
	store = withApproval(store, "/proj", "srv", hash, "rejected");
	assert.equal(storedApproval(store, "/proj", "srv", hash), "rejected");
	assert.deepEqual(readApprovalStore("/nonexistent/path/approvals.json"), {});
});

test("resolveMcpHarnessConfig reads environment overrides", () => {
	const defaults = resolveMcpHarnessConfig({} as NodeJS.ProcessEnv, "/agent");
	assert.equal(defaults.enabled, true);
	assert.equal(defaults.userConfigPath, "/agent/mcp.json");
	assert.equal(defaults.approvalsPath, "/agent/mcp-approvals.json");
	assert.equal(defaults.startupTimeoutMs, 30_000);
	assert.equal(defaults.maxOutputTokens, 25_000);
	const custom = resolveMcpHarnessConfig({
		PI_HARNESS_DISABLE_MCP: "1",
		MCP_TIMEOUT: "10000",
		MCP_TOOL_TIMEOUT: "5000",
		MAX_MCP_OUTPUT_TOKENS: "50000",
		PI_HARNESS_MCP_ENABLE_ALL_PROJECT_SERVERS: "1",
		PI_HARNESS_MCP_USER_CONFIG: "/tmp/custom-mcp.json",
	} as NodeJS.ProcessEnv, "/agent");
	assert.equal(custom.enabled, false);
	assert.equal(custom.startupTimeoutMs, 10_000);
	assert.equal(custom.toolTimeoutMs, 5_000);
	assert.equal(custom.maxOutputTokens, 50_000);
	assert.equal(custom.enableAllProjectServers, true);
	assert.equal(custom.userConfigPath, "/tmp/custom-mcp.json");
});

/* ------------------------------------------------------------------ *
 * Policy integration
 * ------------------------------------------------------------------ */

test("harness policy confirm-gates MCP tools in default mode and blocks them in plan mode", () => {
	const defaultMode = classifyCustomTool("default", "mcp__github__create_issue", process.cwd(), { title: "x" });
	assert.equal(defaultMode.action, "confirm");
	assert.equal((defaultMode as { category: string }).category, "mcp-operation");
	assert.equal(classifyCustomTool("plan", "mcp__github__create_issue", process.cwd(), {}).action, "block");
	assert.equal(classifyCustomTool("yolo", "mcp__github__create_issue", process.cwd(), {}).action, "allow");
	// Resource helper tools stay usable in read-only modes.
	assert.equal(classifyCustomTool("inspect", "list_mcp_resources", process.cwd(), {}).action, "allow");
	assert.equal(classifyCustomTool("plan", "read_mcp_resource", process.cwd(), { server: "s", uri: "res://x" }).action, "allow");
});

/* ------------------------------------------------------------------ *
 * stdio integration: real MCP handshake against a fixture server
 * ------------------------------------------------------------------ */

const FIXTURE_SERVER = String.raw`
let buf = "";
let pingWaiters = new Map();
let nextServerId = 1000;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (line) handle(JSON.parse(line));
	}
});
function handle(msg) {
	if (msg.id !== undefined && msg.method === undefined) {
		const waiter = pingWaiters.get(msg.id);
		if (waiter) { pingWaiters.delete(msg.id); waiter(msg); }
		return;
	}
	const { id, method, params } = msg;
	if (method === "initialize") {
		send({ jsonrpc: "2.0", id, result: {
			protocolVersion: params.protocolVersion,
			capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
			serverInfo: { name: "fixture", version: "1.2.3" },
		} });
	} else if (method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools: [
			{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
			{ name: "fail", description: "Always errors", inputSchema: { type: "object", properties: {} } },
			{ name: "slow", description: "Sleeps 500ms", inputSchema: { type: "object", properties: {} } },
			{ name: "ping_me", description: "Round-trips a ping to the client", inputSchema: { type: "object", properties: {} } },
		] } });
	} else if (method === "prompts/list") {
		send({ jsonrpc: "2.0", id, result: { prompts: [
			{ name: "review", description: "Review something", arguments: [{ name: "target", required: true }] },
		] } });
	} else if (method === "prompts/get") {
		send({ jsonrpc: "2.0", id, result: { messages: [
			{ role: "user", content: { type: "text", text: "Please review " + params.arguments.target } },
		] } });
	} else if (method === "resources/list") {
		send({ jsonrpc: "2.0", id, result: { resources: [{ uri: "fixture://readme", name: "readme" }] } });
	} else if (method === "resources/read") {
		send({ jsonrpc: "2.0", id, result: { contents: [{ uri: params.uri, text: "resource body" }] } });
	} else if (method === "tools/call") {
		const name = params.name;
		if (name === "echo") {
			send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo: " + params.arguments.text }] } });
		} else if (name === "fail") {
			send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "boom" }] } });
		} else if (name === "slow") {
			setTimeout(() => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "done" }] } }), 500);
		} else if (name === "ping_me") {
			const pingId = nextServerId++;
			pingWaiters.set(pingId, (response) => {
				send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: response.error ? "ping-error" : "pong-ok" }] } });
			});
			send({ jsonrpc: "2.0", id: pingId, method: "ping" });
			send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		} else {
			send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
		}
	} else if (id !== undefined) {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
	}
}
`;

function fixtureClient(notifications: string[]): McpClient {
	const transport = new StdioTransport({
		command: process.execPath,
		args: ["-e", FIXTURE_SERVER],
		env: process.env as Record<string, string | undefined>,
	});
	return new McpClient({
		transport,
		clientName: "harness-test",
		rootPath: process.cwd(),
		defaultTimeoutMs: 5_000,
		onNotification: (method) => notifications.push(method),
	});
}

test("McpClient performs a full stdio handshake and round-trips tools", async () => {
	const notifications: string[] = [];
	const client = fixtureClient(notifications);
	try {
		await client.connect(5_000);
		assert.equal(client.serverInfo.name, "fixture");
		assert.equal(client.serverInfo.version, "1.2.3");
		assert.ok(client.capabilities.tools);

		const tools = await client.listTools(5_000);
		assert.deepEqual(tools.map((tool) => tool.name), ["echo", "fail", "slow", "ping_me"]);

		const echo = await client.callTool("echo", { text: "hi" }, { timeoutMs: 5_000 });
		assert.equal(echo.isError ?? false, false);
		assert.deepEqual(convertMcpContent(echo.content), [{ type: "text", text: "echo: hi" }]);

		const failed = await client.callTool("fail", {}, { timeoutMs: 5_000 });
		assert.equal(failed.isError, true);

		// The fixture round-trips a server->client ping before responding, and
		// emits a tools/list_changed notification on the way.
		const ping = await client.callTool("ping_me", {}, { timeoutMs: 5_000 });
		assert.deepEqual(convertMcpContent(ping.content), [{ type: "text", text: "pong-ok" }]);
		assert.ok(notifications.includes("notifications/tools/list_changed"));

		const prompts = await client.listPrompts(5_000);
		assert.equal(prompts[0]?.name, "review");
		const prompt = await client.getPrompt("review", { target: "PR 7" }, 5_000);
		assert.equal(promptMessagesToText(prompt.messages), "Please review PR 7");

		const resources = await client.listResources(5_000);
		assert.equal(resources[0]?.uri, "fixture://readme");
		const resource = await client.readResource("fixture://readme", 5_000);
		assert.equal(resource.contents?.[0]?.text, "resource body");
	} finally {
		await client.close();
	}
});

test("McpClient enforces per-request timeouts and surfaces JSON-RPC errors", async () => {
	const client = fixtureClient([]);
	try {
		await client.connect(5_000);
		await assert.rejects(client.callTool("slow", {}, { timeoutMs: 100 }), /timed out after 100ms/);
		await assert.rejects(client.callTool("nope", {}, { timeoutMs: 5_000 }), /MCP error -32602/);
		await assert.rejects(client.request("unknown/method", {}, { timeoutMs: 5_000 }), /MCP error -32601/);
	} finally {
		await client.close();
	}
});

test("McpClient rejects pending requests when the server process dies", async () => {
	const transport = new StdioTransport({
		command: process.execPath,
		args: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(1), 150);"],
		env: process.env as Record<string, string | undefined>,
	});
	const client = new McpClient({ transport, defaultTimeoutMs: 5_000 });
	await assert.rejects(
		(async () => {
			await transport.start();
			await client.request("initialize", {}, { timeoutMs: 5_000 });
		})(),
		/MCP connection closed/,
	);
	await client.close();
});

/* ------------------------------------------------------------------ *
 * Extension-level integration: factory + fake ExtensionAPI + on-disk config
 * ------------------------------------------------------------------ */

interface RegisteredTool {
	name: string;
	description: string;
	execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

function fakeExtensionApi() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const userMessages: string[] = [];
	const api = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => unknown }) => commands.set(name, options),
		registerEntryRenderer: () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		sendUserMessage: (content: string) => userMessages.push(content),
		getActiveTools: () => [...tools.keys()],
		setActiveTools: () => {},
	} as unknown as ExtensionAPI;
	return { api, tools, commands, handlers, entries, userMessages };
}

function fakeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		isProjectTrusted: () => false,
		ui: {
			notify: () => {},
			confirm: async () => false,
			setStatus: () => {},
			theme: { fg: (_c: string, text: string) => text, bold: (text: string) => text },
		},
	} as unknown as ExtensionContext;
}

test("mcp extension connects configured servers and bridges tools, prompts, and resources", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "pi-mcp-test-"));
	const userConfig = join(scratch, "mcp.json");
	writeFileSync(userConfig, JSON.stringify({
		mcpServers: {
			fixture: { type: "stdio", command: process.execPath, args: ["-e", FIXTURE_SERVER] },
		},
	}, null, 2));
	const previous = process.env.PI_HARNESS_MCP_USER_CONFIG;
	process.env.PI_HARNESS_MCP_USER_CONFIG = userConfig;
	try {
		const { api, tools, commands, handlers, userMessages } = fakeExtensionApi();
		mcpExtension(api);
		assert.ok(commands.has("mcp"), "registers the /mcp command at load");

		const ctx = fakeContext(scratch);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

		// Tools are bridged with Claude Code naming.
		const echo = tools.get("mcp__fixture__echo");
		assert.ok(echo, "echo tool registered as mcp__fixture__echo");
		assert.match(echo.description, /Echo text back/);
		const result = await echo.execute("call-1", { text: "round trip" });
		assert.deepEqual(result.content[0], { type: "text", text: "echo: round trip" });

		// MCP tool errors surface as thrown errors (pi marks isError).
		const fail = tools.get("mcp__fixture__fail");
		assert.ok(fail);
		await assert.rejects(fail.execute("call-2", {}), /boom/);

		// Prompts appear as /mcp__fixture__review and send a user message.
		const promptCommand = commands.get("mcp__fixture__review");
		assert.ok(promptCommand, "prompt registered as command");
		await promptCommand.handler("PR-42", ctx);
		assert.deepEqual(userMessages, ["Please review PR-42"]);

		// Resource helper tools registered because the server declares resources.
		const listResources = tools.get("list_mcp_resources");
		assert.ok(listResources, "list_mcp_resources registered");
		const listing = await listResources.execute("call-3", { server: "fixture" });
		assert.match(listing.content[0]?.text ?? "", /fixture:\/\/readme/);
		const readResource = tools.get("read_mcp_resource");
		assert.ok(readResource);
		const body = await readResource.execute("call-4", { server: "fixture", uri: "fixture://readme" });
		assert.equal(body.content[0]?.text, "resource body");

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);

		// After shutdown the bridge reports servers as unavailable.
		await assert.rejects(echo.execute("call-5", { text: "late" }), /not connected/);
	} finally {
		if (previous === undefined) delete process.env.PI_HARNESS_MCP_USER_CONFIG;
		else process.env.PI_HARNESS_MCP_USER_CONFIG = previous;
		rmSync(scratch, { recursive: true, force: true });
	}
});
