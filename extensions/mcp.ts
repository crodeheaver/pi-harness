/**
 * MCP server integration extension.
 *
 * Ports Claude Code's MCP support into the audited harness:
 * - Servers are configured in Claude Code-compatible `mcpServers` documents at
 *   three scopes with the same precedence (local > project > user):
 *     - local:   `.pi/mcp.local.json` (project-private; keep out of VCS)
 *     - project: `.mcp.json` at the project root (shared via VCS)
 *     - user:    `~/.pi/agent/mcp.json` (all projects)
 * - stdio, streamable HTTP (`http` / `streamable-http`), and legacy `sse`
 *   transports; `${VAR}` / `${VAR:-default}` expansion in commands, args, env,
 *   URLs, and headers.
 * - Server tools are exposed to the LLM as `mcp__<server>__<tool>`; server
 *   prompts become `/mcp__<server>__<prompt>` commands; servers with resources
 *   light up `list_mcp_resources` / `read_mcp_resource` tools.
 * - Project-scope servers (`.mcp.json`, `.pi/mcp.local.json`) require one-time
 *   user approval, pinned to the config hash and remembered in
 *   `~/.pi/agent/mcp-approvals.json`. Both files are only read in trusted
 *   projects.
 * - `/mcp` manages everything in-session: list, get, add, add-json, remove,
 *   reload, reset-project-choices.
 *
 * Safety: every `mcp__*` tool call is classified by the harness policy
 * (`classifyCustomTool` matches `mcp_` names) — confirm-gated per tool in
 * default mode, blocked in inspect/plan, allowed in permissive/yolo. Failed
 * remote servers reconnect with exponential backoff (5 attempts); stdio
 * servers are not auto-restarted (Claude Code parity).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import {
	configHash,
	convertMcpContent,
	DEFAULT_MAX_OUTPUT_TOKENS,
	DEFAULT_STARTUP_TIMEOUT_MS,
	DEFAULT_TOOL_TIMEOUT_MS,
	limitToolOutput,
	McpClient,
	mcpPromptCommandName,
	mcpToolName,
	mergeServerScopes,
	parseAddArgs,
	parseMcpDocument,
	SseTransport,
	StdioTransport,
	StreamableHttpTransport,
	tokenize,
	toolParametersSchema,
	type McpPromptInfo,
	type McpScope,
	type McpServerEntry,
	type McpTransport,
	type PiToolContent,
	type ScopedServers,
} from "./mcp-core.ts";

export const MCP_STATUS_ENTRY = "audited-harness:mcp-status";
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1_000;

/* ------------------------------------------------------------------ *
 * Harness-level configuration (environment)
 * ------------------------------------------------------------------ */

export interface McpHarnessConfig {
	enabled: boolean;
	userConfigPath: string;
	approvalsPath: string;
	startupTimeoutMs: number;
	toolTimeoutMs: number;
	maxOutputTokens: number;
	/** Auto-approve project-scope servers (analog of enableAllProjectMcpServers). */
	enableAllProjectServers: boolean;
}

function positiveInt(value: string | undefined): number | undefined {
	if (!value?.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function expandHome(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function resolveMcpHarnessConfig(env: NodeJS.ProcessEnv, agentDir: string): McpHarnessConfig {
	const userOverride = env.PI_HARNESS_MCP_USER_CONFIG?.trim();
	return {
		enabled: env.PI_HARNESS_DISABLE_MCP !== "1",
		userConfigPath: userOverride ? resolve(expandHome(userOverride)) : join(agentDir, "mcp.json"),
		approvalsPath: join(agentDir, "mcp-approvals.json"),
		startupTimeoutMs: positiveInt(env.MCP_TIMEOUT) ?? DEFAULT_STARTUP_TIMEOUT_MS,
		toolTimeoutMs: positiveInt(env.MCP_TOOL_TIMEOUT) ?? DEFAULT_TOOL_TIMEOUT_MS,
		maxOutputTokens: positiveInt(env.MAX_MCP_OUTPUT_TOKENS) ?? DEFAULT_MAX_OUTPUT_TOKENS,
		enableAllProjectServers: env.PI_HARNESS_MCP_ENABLE_ALL_PROJECT_SERVERS === "1",
	};
}

/* ------------------------------------------------------------------ *
 * Project-server approvals (pinned to config hash)
 * ------------------------------------------------------------------ */

export type ApprovalChoice = "approved" | "rejected";
export interface ApprovalStore {
	[projectPath: string]: { [serverName: string]: { hash: string; choice: ApprovalChoice } };
}

export function readApprovalStore(path: string): ApprovalStore {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ApprovalStore) : {};
	} catch {
		return {};
	}
}

export function storedApproval(store: ApprovalStore, project: string, server: string, hash: string): ApprovalChoice | undefined {
	const entry = store[project]?.[server];
	return entry && entry.hash === hash ? entry.choice : undefined;
}

export function withApproval(store: ApprovalStore, project: string, server: string, hash: string, choice: ApprovalChoice): ApprovalStore {
	return { ...store, [project]: { ...store[project], [server]: { hash, choice } } };
}

function writeApprovalStore(path: string, store: ApprovalStore): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ *
 * Prompt message flattening
 * ------------------------------------------------------------------ */

/** Flatten `prompts/get` messages into a single user-message text. */
export function promptMessagesToText(messages: Array<{ role?: string; content?: unknown }> | undefined): string {
	const parts: string[] = [];
	for (const message of messages ?? []) {
		const blocks = Array.isArray(message.content) ? message.content : [message.content];
		const texts: string[] = [];
		for (const raw of blocks) {
			const block = raw as Record<string, unknown> | undefined;
			if (!block) continue;
			if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
			else if (block.type === "resource") {
				const resource = (block.resource ?? {}) as Record<string, unknown>;
				if (typeof resource.text === "string") texts.push(resource.text);
			}
		}
		if (!texts.length) continue;
		parts.push(message.role === "assistant" ? `[assistant]\n${texts.join("\n")}` : texts.join("\n"));
	}
	return parts.join("\n\n");
}

/* ------------------------------------------------------------------ *
 * Extension
 * ------------------------------------------------------------------ */

type ServerStatus = "disconnected" | "connecting" | "connected" | "failed" | "needs-approval" | "rejected";

interface ManagedServer {
	entry: McpServerEntry;
	status: ServerStatus;
	client?: McpClient;
	error?: string;
	toolNames: Map<string, string>;
	promptCommands: Map<string, string>;
	hasResources: boolean;
	reconnectAttempts: number;
	reconnectTimer?: NodeJS.Timeout;
	refreshTimer?: NodeJS.Timeout;
	disposed: boolean;
}

interface StatusSnapshot {
	name: string;
	scope: McpScope;
	transport: string;
	status: ServerStatus;
	tools: number;
	prompts: number;
	error?: string;
	server?: string;
}

function describeConfig(entry: McpServerEntry): string {
	const config = entry.config;
	if (config.type === "stdio") return `stdio: ${[config.command, ...config.args].join(" ")}`;
	return `${config.type}: ${config.url}`;
}

export default function mcpExtension(pi: ExtensionAPI) {
	const cfg = resolveMcpHarnessConfig(process.env, getAgentDir());
	const servers = new Map<string, ManagedServer>();
	let activeCtx: ExtensionContext | undefined;
	let resourceToolsRegistered = false;
	let projectKey = resolve(process.cwd());

	function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		try {
			if (activeCtx?.hasUI) activeCtx.ui.notify(message, level);
		} catch { /* stale ctx after session replacement */ }
	}

	function updateStatus(): void {
		try {
			if (!activeCtx?.hasUI) return;
			const theme = activeCtx.ui.theme;
			const total = servers.size;
			if (!total) {
				activeCtx.ui.setStatus("audited-harness:mcp", "");
				return;
			}
			const connected = [...servers.values()].filter((server) => server.status === "connected").length;
			const failed = [...servers.values()].filter((server) => server.status === "failed").length;
			const color = failed ? "warning" : connected === total ? "success" : "muted";
			activeCtx.ui.setStatus("audited-harness:mcp", theme.fg(color, `mcp ${connected}/${total}`));
		} catch { /* stale ctx after session replacement */ }
	}

	/* -------------------- tool execution -------------------- */

	async function executeMcpTool(serverName: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal) {
		const server = servers.get(serverName);
		if (!server?.client || server.status !== "connected") {
			throw new Error(`MCP server "${serverName}" is not connected${server?.error ? ` (${server.error})` : ""}`);
		}
		const timeoutMs = server.entry.config.timeout ?? cfg.toolTimeoutMs;
		const result = await server.client.callTool(toolName, args, { timeoutMs, signal });
		const content = convertMcpContent(result.content, result.structuredContent);
		const text = content.filter((block): block is Extract<PiToolContent, { type: "text" }> => block.type === "text").map((block) => block.text).join("\n");
		if (result.isError) throw new Error(text || `MCP tool "${toolName}" reported an error`);
		const limited = limitToolOutput(text, cfg.maxOutputTokens);
		let finalContent: PiToolContent[] = content;
		if (limited.truncated) {
			finalContent = [{ type: "text", text: limited.text }, ...content.filter((block) => block.type === "image")];
		}
		return {
			content: finalContent,
			details: {
				server: serverName,
				tool: toolName,
				estimatedTokens: limited.estimatedTokens,
				truncated: limited.truncated,
				...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
			},
		};
	}

	function registerServerTools(server: ManagedServer, tools: Array<{ name: string; description?: string; title?: string; inputSchema?: unknown }>): void {
		const next = new Map<string, string>();
		for (const tool of tools) {
			const piName = mcpToolName(server.entry.name, tool.name);
			next.set(piName, tool.name);
			const mcpName = tool.name;
			pi.registerTool({
				name: piName,
				label: `${server.entry.name}: ${tool.name}`,
				description: `${tool.description?.trim() || tool.title || tool.name} (MCP tool from server "${server.entry.name}")`,
				parameters: toolParametersSchema(tool.inputSchema) as unknown as TSchema,
				async execute(_toolCallId, params, signal) {
					return executeMcpTool(server.entry.name, mcpName, (params ?? {}) as Record<string, unknown>, signal);
				},
				renderCall(args, theme) {
					const preview = JSON.stringify(args ?? {});
					return new Text(`${theme.fg("toolTitle", theme.bold(piName))} ${theme.fg("muted", preview.length > 80 ? `${preview.slice(0, 80)}…` : preview)}`, 0, 0);
				},
				renderResult(result, _options, theme) {
					const details = result.details as { estimatedTokens?: number; truncated?: boolean } | undefined;
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${server.entry.name} · ~${details?.estimatedTokens ?? 0} tokens${details?.truncated ? " · truncated" : ""}`), 0, 0);
				},
			});
		}
		const removed = [...server.toolNames.keys()].filter((name) => !next.has(name));
		server.toolNames = next;
		if (removed.length) {
			try {
				pi.setActiveTools(pi.getActiveTools().filter((name) => !removed.includes(name)));
			} catch { /* tool refresh unavailable outside a bound session */ }
		}
	}

	async function refreshTools(server: ManagedServer): Promise<void> {
		if (!server.client) return;
		const tools = await server.client.listTools(cfg.startupTimeoutMs);
		registerServerTools(server, tools);
	}

	/* -------------------- prompts as commands -------------------- */

	async function runPromptCommand(serverName: string, prompt: McpPromptInfo, args: string, ctx: ExtensionContext): Promise<void> {
		const server = servers.get(serverName);
		if (!server?.client || server.status !== "connected") {
			if (ctx.hasUI) ctx.ui.notify(`MCP server "${serverName}" is not connected`, "error");
			return;
		}
		const declared = prompt.arguments ?? [];
		const tokens = tokenize(args ?? "");
		const values: Record<string, string> = {};
		declared.forEach((argument, index) => {
			if (tokens[index] !== undefined) values[argument.name] = tokens[index];
		});
		const missing = declared.filter((argument) => argument.required && values[argument.name] === undefined);
		if (missing.length) {
			const usage = declared.map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`)).join(" ");
			if (ctx.hasUI) ctx.ui.notify(`Usage: /${mcpPromptCommandName(serverName, prompt.name)} ${usage}`, "error");
			return;
		}
		try {
			const result = await server.client.getPrompt(prompt.name, values, cfg.startupTimeoutMs);
			const text = promptMessagesToText(result.messages);
			if (!text.trim()) {
				if (ctx.hasUI) ctx.ui.notify(`MCP prompt "${prompt.name}" returned no text content`, "warning");
				return;
			}
			pi.sendUserMessage(text);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`MCP prompt failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	async function refreshPrompts(server: ManagedServer): Promise<void> {
		if (!server.client) return;
		const prompts = await server.client.listPrompts(cfg.startupTimeoutMs);
		server.promptCommands = new Map();
		for (const prompt of prompts) {
			const commandName = mcpPromptCommandName(server.entry.name, prompt.name);
			server.promptCommands.set(commandName, prompt.name);
			pi.registerCommand(commandName, {
				description: `${prompt.description?.trim() || prompt.title || prompt.name} (MCP prompt from "${server.entry.name}")`,
				handler: (args, ctx) => runPromptCommand(server.entry.name, prompt, args ?? "", ctx),
			});
		}
	}

	/* -------------------- resource tools -------------------- */

	function connectedResourceServers(filter?: string): ManagedServer[] {
		return [...servers.values()].filter((server) =>
			server.status === "connected" && server.hasResources && (!filter || server.entry.name === filter));
	}

	function ensureResourceTools(): void {
		if (resourceToolsRegistered) return;
		resourceToolsRegistered = true;
		pi.registerTool({
			name: "list_mcp_resources",
			label: "List MCP Resources",
			description: "List resources available from connected MCP servers, optionally filtered to one server.",
			parameters: Type.Object({
				server: Type.Optional(Type.String({ description: "Only list resources from this MCP server" })),
			}),
			async execute(_toolCallId, params) {
				const candidates = connectedResourceServers(params.server);
				if (!candidates.length) {
					throw new Error(params.server ? `MCP server "${params.server}" is not connected or exposes no resources` : "No connected MCP servers expose resources");
				}
				const listed: Array<Record<string, unknown>> = [];
				for (const server of candidates) {
					try {
						const resources = await server.client!.listResources(cfg.startupTimeoutMs);
						for (const resource of resources) listed.push({ server: server.entry.name, ...resource });
					} catch (error) {
						listed.push({ server: server.entry.name, error: error instanceof Error ? error.message : String(error) });
					}
				}
				return { content: [{ type: "text" as const, text: JSON.stringify(listed, null, 2) }], details: { count: listed.length } };
			},
		});
		pi.registerTool({
			name: "read_mcp_resource",
			label: "Read MCP Resource",
			description: "Read one resource from a connected MCP server by URI (find URIs with list_mcp_resources).",
			parameters: Type.Object({
				server: Type.String({ description: "MCP server name" }),
				uri: Type.String({ description: "Resource URI to read" }),
			}),
			async execute(_toolCallId, params) {
				const server = servers.get(params.server);
				if (!server?.client || server.status !== "connected") throw new Error(`MCP server "${params.server}" is not connected`);
				const result = await server.client.readResource(params.uri, cfg.toolTimeoutMs);
				const content: PiToolContent[] = [];
				for (const item of result.contents ?? []) {
					if (typeof item.text === "string") content.push({ type: "text", text: item.text });
					else if (typeof item.blob === "string" && typeof item.mimeType === "string" && item.mimeType.startsWith("image/")) {
						content.push({ type: "image", data: item.blob, mimeType: item.mimeType });
					} else content.push({ type: "text", text: `[binary resource ${String(item.uri ?? params.uri)} (${String(item.mimeType ?? "unknown type")})]` });
				}
				if (!content.length) content.push({ type: "text", text: "(empty resource)" });
				const text = content.filter((block): block is Extract<PiToolContent, { type: "text" }> => block.type === "text").map((block) => block.text).join("\n");
				const limited = limitToolOutput(text, cfg.maxOutputTokens);
				return {
					content: limited.truncated ? [{ type: "text" as const, text: limited.text }] : content,
					details: { server: params.server, uri: params.uri, truncated: limited.truncated },
				};
			},
		});
	}

	/* -------------------- connection lifecycle -------------------- */

	function buildTransport(entry: McpServerEntry, cwd: string): McpTransport {
		const config = entry.config;
		if (config.type === "stdio") {
			return new StdioTransport({
				command: config.command,
				args: config.args,
				cwd: config.cwd ? resolve(cwd, config.cwd) : cwd,
				env: {
					...process.env,
					...config.env,
					PI_HARNESS_PROJECT_DIR: cwd,
					// Compatibility with servers written against Claude Code.
					CLAUDE_PROJECT_DIR: cwd,
				},
			});
		}
		if (config.type === "http") return new StreamableHttpTransport({ url: config.url, headers: config.headers });
		return new SseTransport({ url: config.url, headers: config.headers, startupTimeoutMs: cfg.startupTimeoutMs });
	}

	function scheduleReconnect(server: ManagedServer): void {
		if (server.disposed || server.entry.config.type === "stdio") return;
		if (server.reconnectTimer) clearTimeout(server.reconnectTimer);
		if (server.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
			server.status = "failed";
			server.error = `${server.error ?? "connection lost"} (gave up after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts)`;
			updateStatus();
			return;
		}
		const delay = RECONNECT_BASE_DELAY_MS * 2 ** server.reconnectAttempts;
		server.reconnectAttempts++;
		server.reconnectTimer = setTimeout(() => {
			if (!server.disposed) void connectServer(server, { isReconnect: true });
		}, delay);
		server.reconnectTimer.unref?.();
	}

	function handleServerClose(server: ManagedServer, reason?: string): void {
		if (server.disposed) return;
		const wasConnected = server.status === "connected";
		server.status = server.entry.config.type === "stdio" ? "failed" : "disconnected";
		server.error = reason ?? "connection closed";
		if (wasConnected) notify(`MCP server "${server.entry.name}" disconnected${reason ? `: ${reason}` : ""}`, "warning");
		updateStatus();
		scheduleReconnect(server);
	}

	function handleNotification(server: ManagedServer, method: string): void {
		if (method !== "notifications/tools/list_changed" && method !== "notifications/prompts/list_changed") return;
		if (server.refreshTimer) clearTimeout(server.refreshTimer);
		server.refreshTimer = setTimeout(() => {
			if (server.disposed || server.status !== "connected") return;
			const refresh = method === "notifications/tools/list_changed" ? refreshTools(server) : refreshPrompts(server);
			void refresh.catch(() => { /* keep previously discovered capabilities on refresh failure */ });
		}, 300);
		server.refreshTimer.unref?.();
	}

	async function connectServer(server: ManagedServer, options?: { isReconnect?: boolean }): Promise<void> {
		if (server.disposed || !cfg.enabled) return;
		server.status = "connecting";
		updateStatus();
		const previousClient = server.client;
		if (previousClient) void previousClient.close().catch(() => {});
		try {
			const transport = buildTransport(server.entry, projectKey);
			const client = new McpClient({
				transport,
				rootPath: projectKey,
				defaultTimeoutMs: server.entry.config.timeout ?? cfg.toolTimeoutMs,
				onNotification: (method) => handleNotification(server, method),
				onClose: (reason) => {
					if (server.client === client) handleServerClose(server, reason);
				},
			});
			server.client = client;
			await client.connect(cfg.startupTimeoutMs);
			if (server.disposed) {
				await client.close();
				return;
			}
			server.status = "connected";
			server.error = undefined;
			server.reconnectAttempts = 0;
			if (client.capabilities.tools) await refreshTools(server);
			if (client.capabilities.prompts) await refreshPrompts(server).catch(() => {});
			if (client.capabilities.resources) {
				server.hasResources = true;
				ensureResourceTools();
			}
			updateStatus();
			if (!options?.isReconnect) {
				notify(`MCP server "${server.entry.name}" connected (${server.toolNames.size} tool${server.toolNames.size === 1 ? "" : "s"})`);
			}
		} catch (error) {
			if (server.status === "connecting") server.status = "failed";
			const diagnostics = server.client?.transport.diagnostics?.();
			server.error = `${error instanceof Error ? error.message : String(error)}${diagnostics ? ` — ${diagnostics.slice(-200)}` : ""}`;
			void server.client?.close().catch(() => {});
			updateStatus();
			if (!options?.isReconnect) notify(`MCP server "${server.entry.name}" failed: ${server.error}`, "warning");
			else scheduleReconnect(server);
		}
	}

	async function disposeServer(server: ManagedServer): Promise<void> {
		server.disposed = true;
		if (server.reconnectTimer) clearTimeout(server.reconnectTimer);
		if (server.refreshTimer) clearTimeout(server.refreshTimer);
		const removed = [...server.toolNames.keys()];
		if (removed.length) {
			try {
				pi.setActiveTools(pi.getActiveTools().filter((name) => !removed.includes(name)));
			} catch { /* no bound session */ }
		}
		if (server.client) await server.client.close().catch(() => {});
	}

	async function disposeAll(): Promise<void> {
		const all = [...servers.values()];
		servers.clear();
		await Promise.all(all.map((server) => disposeServer(server)));
	}

	/* -------------------- startup -------------------- */

	function readScopedDocument(path: string, scope: McpScope, warnings: string[]): ScopedServers | undefined {
		if (!existsSync(path)) return undefined;
		try {
			const parsed = parseMcpDocument(readFileSync(path, "utf8"));
			if (parsed.error) {
				warnings.push(`${path}: ${parsed.error}`);
				return undefined;
			}
			return { scope, servers: parsed.servers };
		} catch (error) {
			warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	function scopePath(scope: McpScope, cwd: string): string {
		if (scope === "user") return cfg.userConfigPath;
		if (scope === "project") return join(cwd, ".mcp.json");
		return join(cwd, CONFIG_DIR_NAME, "mcp.local.json");
	}

	async function resolveApprovalInteractively(server: ManagedServer, ctx: ExtensionContext): Promise<ApprovalChoice | "undecided"> {
		const hash = configHash(server.entry.raw);
		const file = scopePath(server.entry.scope, projectKey);
		if (!ctx.hasUI) return "undecided";
		let approved = false;
		try {
			approved = await ctx.ui.confirm(
				`Use MCP server "${server.entry.name}"?`,
				`Defined in ${file}\n${describeConfig(server.entry)}\n\nMCP servers run code and can access the network on your behalf. Only approve servers you trust. This choice is remembered until the config changes.`,
			);
		} catch {
			return "undecided";
		}
		const choice: ApprovalChoice = approved ? "approved" : "rejected";
		try {
			writeApprovalStore(cfg.approvalsPath, withApproval(readApprovalStore(cfg.approvalsPath), projectKey, server.entry.name, hash, choice));
		} catch { /* approval persistence is best-effort */ }
		return choice;
	}

	async function startAll(ctx: ExtensionContext): Promise<void> {
		await disposeAll();
		activeCtx = ctx;
		projectKey = resolve(ctx.cwd);
		if (!cfg.enabled) return;
		const warnings: string[] = [];
		const scoped: ScopedServers[] = [];
		const userDocument = readScopedDocument(cfg.userConfigPath, "user", warnings);
		if (userDocument) scoped.push(userDocument);
		const projectPath = scopePath("project", projectKey);
		const localPath = scopePath("local", projectKey);
		if (ctx.isProjectTrusted()) {
			const projectDocument = readScopedDocument(projectPath, "project", warnings);
			if (projectDocument) scoped.push(projectDocument);
			const localDocument = readScopedDocument(localPath, "local", warnings);
			if (localDocument) scoped.push(localDocument);
		} else if (existsSync(projectPath) || existsSync(localPath)) {
			warnings.push("project MCP config skipped: project is not trusted");
		}
		const merged = mergeServerScopes(scoped, process.env);
		warnings.push(...merged.warnings);
		for (const warning of warnings) notify(`MCP: ${warning}`, "warning");
		if (!merged.entries.length) {
			updateStatus();
			return;
		}
		const approvals = readApprovalStore(cfg.approvalsPath);
		const undecided: ManagedServer[] = [];
		const connecting: Array<Promise<void>> = [];
		for (const entry of merged.entries) {
			const server: ManagedServer = {
				entry,
				status: "disconnected",
				toolNames: new Map(),
				promptCommands: new Map(),
				hasResources: false,
				reconnectAttempts: 0,
				disposed: false,
			};
			servers.set(entry.name, server);
			if (entry.scope === "user" || cfg.enableAllProjectServers) {
				connecting.push(connectServer(server));
				continue;
			}
			const stored = storedApproval(approvals, projectKey, entry.name, configHash(entry.raw));
			if (stored === "approved") connecting.push(connectServer(server));
			else if (stored === "rejected") server.status = "rejected";
			else undecided.push(server);
		}
		for (const server of undecided) {
			const choice = await resolveApprovalInteractively(server, ctx);
			if (choice === "approved") connecting.push(connectServer(server));
			else server.status = choice === "rejected" ? "rejected" : "needs-approval";
		}
		// One-shot runs (print/json mode) need servers ready before the first turn;
		// interactive sessions connect in the background instead.
		if (!ctx.hasUI) await Promise.allSettled(connecting);
		updateStatus();
	}

	/* -------------------- /mcp command -------------------- */

	function snapshot(): StatusSnapshot[] {
		return [...servers.values()].map((server) => ({
			name: server.entry.name,
			scope: server.entry.scope,
			transport: server.entry.config.type,
			status: server.status,
			tools: server.toolNames.size,
			prompts: server.promptCommands.size,
			error: server.error,
			server: server.client?.serverInfo?.name ? `${server.client.serverInfo.name}${server.client.serverInfo.version ? ` v${server.client.serverInfo.version}` : ""}` : undefined,
		}));
	}

	function statusLine(entry: StatusSnapshot): string {
		const marks: Record<ServerStatus, string> = {
			connected: "✓", connecting: "…", failed: "✗", disconnected: "○", "needs-approval": "⏸", rejected: "⊘",
		};
		const extras = [entry.status === "connected" ? `${entry.tools} tools${entry.prompts ? `, ${entry.prompts} prompts` : ""}` : entry.status, entry.error ?? ""].filter(Boolean);
		return `${marks[entry.status]} ${entry.name} [${entry.scope}/${entry.transport}] — ${extras.join(" — ")}`;
	}

	function showStatus(ctx: ExtensionContext): void {
		const entries = snapshot();
		if (!entries.length) {
			if (ctx.hasUI) ctx.ui.notify(`No MCP servers configured. Add one with /mcp add, or create ${scopePath("project", projectKey)}`, "info");
			return;
		}
		pi.appendEntry(MCP_STATUS_ENTRY, { servers: entries, timestamp: Date.now() });
		if (ctx.hasUI) {
			const connected = entries.filter((entry) => entry.status === "connected").length;
			ctx.ui.notify(`MCP: ${connected}/${entries.length} servers connected`, connected === entries.length ? "info" : "warning");
		}
	}

	async function addServer(name: string, raw: Record<string, unknown>, scope: McpScope, ctx: ExtensionContext): Promise<void> {
		if (scope !== "user" && !ctx.isProjectTrusted()) {
			if (ctx.hasUI) ctx.ui.notify(`Cannot write ${scope}-scope MCP config: project is not trusted (use --scope user)`, "error");
			return;
		}
		const path = scopePath(scope, projectKey);
		let document: Record<string, unknown> = {};
		if (existsSync(path)) {
			try {
				document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			} catch {
				if (ctx.hasUI) ctx.ui.notify(`${path} contains invalid JSON; fix it before adding servers`, "error");
				return;
			}
		}
		const mcpServers = (document.mcpServers ?? {}) as Record<string, unknown>;
		mcpServers[name] = raw;
		document.mcpServers = mcpServers;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
		// The user added this server explicitly; record approval for project scopes.
		if (scope !== "user") {
			try {
				writeApprovalStore(cfg.approvalsPath, withApproval(readApprovalStore(cfg.approvalsPath), projectKey, name, configHash(raw), "approved"));
			} catch { /* best-effort */ }
		}
		const merged = mergeServerScopes([{ scope, servers: { [name]: raw } }], process.env);
		for (const warning of merged.warnings) notify(`MCP: ${warning}`, "warning");
		const entry = merged.entries[0];
		if (!entry) return;
		const existing = servers.get(name);
		if (existing) await disposeServer(existing);
		const server: ManagedServer = {
			entry, status: "disconnected", toolNames: new Map(), promptCommands: new Map(), hasResources: false, reconnectAttempts: 0, disposed: false,
		};
		servers.set(name, server);
		if (ctx.hasUI) ctx.ui.notify(`Added MCP server "${name}" to ${path}`, "info");
		await connectServer(server);
	}

	async function removeServer(name: string, requestedScope: McpScope | undefined, ctx: ExtensionContext): Promise<void> {
		let removedFrom: string[] = [];
		for (const scope of ["local", "project", "user"] as const) {
			if (requestedScope && requestedScope !== scope) continue;
			if (scope !== "user" && !ctx.isProjectTrusted()) continue;
			const path = scopePath(scope, projectKey);
			if (!existsSync(path)) continue;
			try {
				const document = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
				if (document.mcpServers && name in document.mcpServers) {
					delete document.mcpServers[name];
					writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
					removedFrom.push(path);
				}
			} catch { /* skip unreadable file */ }
		}
		const server = servers.get(name);
		if (server) {
			servers.delete(name);
			await disposeServer(server);
		}
		updateStatus();
		if (ctx.hasUI) {
			ctx.ui.notify(removedFrom.length ? `Removed MCP server "${name}" from ${removedFrom.join(", ")}` : server ? `Disconnected MCP server "${name}" (no config entry found)` : `No MCP server named "${name}"`, removedFrom.length || server ? "info" : "error");
		}
	}

	const SUBCOMMANDS = ["list", "get", "add", "add-json", "remove", "reload", "reset-project-choices", "help"];

	pi.registerCommand("mcp", {
		description: "Manage MCP servers (list, get, add, add-json, remove, reload, reset-project-choices)",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(prefix)).map((sub) => ({ value: sub, label: sub }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const tokens = tokenize(args ?? "");
			const subcommand = tokens[0] ?? "list";
			if (subcommand === "list") return showStatus(ctx);
			if (subcommand === "get") {
				const server = servers.get(tokens[1] ?? "");
				if (!server) {
					if (ctx.hasUI) ctx.ui.notify(`No MCP server named "${tokens[1] ?? ""}"`, "error");
					return;
				}
				pi.appendEntry(MCP_STATUS_ENTRY, { servers: snapshot().filter((entry) => entry.name === server.entry.name), detail: describeConfig(server.entry), timestamp: Date.now() });
				return;
			}
			if (subcommand === "add") {
				const parsed = parseAddArgs(tokens.slice(1));
				if (parsed.error || !parsed.name || !parsed.raw) {
					if (ctx.hasUI) ctx.ui.notify(`/mcp add: ${parsed.error ?? "invalid arguments"}`, "error");
					return;
				}
				return addServer(parsed.name, parsed.raw, parsed.scope, ctx);
			}
			if (subcommand === "add-json") {
				const name = tokens[1];
				const json = (args ?? "").slice((args ?? "").indexOf(name ?? "") + (name?.length ?? 0)).trim();
				if (!name || !json) {
					if (ctx.hasUI) ctx.ui.notify("Usage: /mcp add-json <name> <json> [--scope not supported here; defaults to local]", "error");
					return;
				}
				try {
					const raw = JSON.parse(json) as Record<string, unknown>;
					return await addServer(name, raw, "local", ctx);
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`/mcp add-json: invalid JSON (${error instanceof Error ? error.message : String(error)})`, "error");
					return;
				}
			}
			if (subcommand === "remove") {
				const scopeIndex = tokens.findIndex((token) => token === "--scope" || token === "-s");
				const requestedScope = scopeIndex >= 0 ? (tokens[scopeIndex + 1] as McpScope | undefined) : undefined;
				const name = tokens.filter((token, index) => index > 0 && token !== "--scope" && token !== "-s" && index !== scopeIndex + 1)[0];
				if (!name) {
					if (ctx.hasUI) ctx.ui.notify("Usage: /mcp remove <name> [--scope local|project|user]", "error");
					return;
				}
				return removeServer(name, requestedScope, ctx);
			}
			if (subcommand === "reload") {
				const target = tokens[1];
				const targets = target ? [servers.get(target)].filter((server): server is ManagedServer => !!server) : [...servers.values()];
				if (target && !targets.length) {
					if (ctx.hasUI) ctx.ui.notify(`No MCP server named "${target}"`, "error");
					return;
				}
				for (const server of targets) {
					server.reconnectAttempts = 0;
					if (server.status === "rejected" || server.status === "needs-approval") continue;
					void connectServer(server, { isReconnect: true });
				}
				if (ctx.hasUI) ctx.ui.notify(`Reconnecting ${targets.length} MCP server${targets.length === 1 ? "" : "s"}…`, "info");
				return;
			}
			if (subcommand === "reset-project-choices") {
				const store = readApprovalStore(cfg.approvalsPath);
				delete store[projectKey];
				try {
					writeApprovalStore(cfg.approvalsPath, store);
				} catch { /* best-effort */ }
				if (ctx.hasUI) ctx.ui.notify("Cleared MCP approval choices for this project (takes effect on /reload)", "info");
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify("Usage: /mcp [list] | get <name> | add [--transport http|sse|stdio] [--scope local|project|user] [--env K=V] [--header \"K: V\"] <name> <url | -- command args…> | add-json <name> <json> | remove <name> | reload [name] | reset-project-choices", "info");
			}
		},
	});

	pi.registerEntryRenderer(MCP_STATUS_ENTRY, (entry, _options, theme) => {
		const data = entry.data as { servers?: StatusSnapshot[]; detail?: string } | undefined;
		const lines = [theme.bold("MCP servers")];
		for (const server of data?.servers ?? []) {
			const line = statusLine(server);
			lines.push(server.status === "connected" ? theme.fg("success", line) : server.status === "failed" || server.status === "rejected" ? theme.fg("warning", line) : theme.fg("muted", line));
		}
		if (data?.detail) lines.push(theme.fg("dim", data.detail));
		return new Text(lines.join("\n"), 1, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		await startAll(ctx);
	});

	pi.on("session_shutdown", async () => {
		activeCtx = undefined;
		await disposeAll();
	});
}
