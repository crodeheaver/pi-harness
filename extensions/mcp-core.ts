/**
 * MCP (Model Context Protocol) core: configuration handling and a minimal,
 * dependency-free MCP client used by `extensions/mcp.ts`.
 *
 * Ports Claude Code's MCP integration semantics:
 * - `.mcp.json`-compatible config with `stdio`, `http` (streamable HTTP, alias
 *   `streamable-http`), and legacy `sse` transports. `ws` is recognized but not
 *   supported.
 * - `${VAR}` / `${VAR:-default}` environment expansion in `command`, `args`,
 *   `env`, `url`, and `headers`.
 * - Scope precedence: local > project > user (whole-entry, no field merging).
 * - Tool names exposed as `mcp__<server>__<tool>`.
 *
 * Protocol implementation follows the MCP spec (rev 2025-06-18):
 * - stdio: newline-delimited JSON-RPC over the child's stdin/stdout.
 * - Streamable HTTP: one POST per message with `Accept: application/json,
 *   text/event-stream`; JSON or SSE responses; `Mcp-Session-Id` and
 *   `MCP-Protocol-Version` headers; optional GET listener stream.
 * - Legacy SSE: GET stream that announces a POST `endpoint` event.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 25_000;
/** Per-server `timeout` values below this are ignored (Claude Code parity). */
export const MIN_SERVER_TIMEOUT_MS = 1_000;

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export type McpScope = "local" | "project" | "user";
export const MCP_SCOPES: readonly McpScope[] = ["local", "project", "user"];

export interface McpStdioConfig {
	type: "stdio";
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	/** Per-server tool-call timeout in ms (overrides MCP_TOOL_TIMEOUT). */
	timeout?: number;
}

export interface McpRemoteConfig {
	type: "http" | "sse";
	url: string;
	headers: Record<string, string>;
	timeout?: number;
}

export type McpServerConfig = McpStdioConfig | McpRemoteConfig;

export interface McpServerEntry {
	name: string;
	scope: McpScope;
	config: McpServerConfig;
	/** Raw (unexpanded) config used for approval hashing. */
	raw: unknown;
}

/**
 * Expand `${VAR}` and `${VAR:-default}` references. Unset variables without a
 * default keep the literal text and are reported (Claude Code parity).
 */
export function expandVariables(value: string, env: NodeJS.ProcessEnv): { value: string; missing: string[] } {
	const missing: string[] = [];
	const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (full, name: string, fallback: string | undefined) => {
		const resolved = env[name];
		if (resolved !== undefined) return resolved;
		if (fallback !== undefined) return fallback;
		missing.push(name);
		return full;
	});
	return { value: expanded, missing };
}

function expandRecord(record: Record<string, string>, env: NodeJS.ProcessEnv, missing: Set<string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		const result = expandVariables(value, env);
		for (const name of result.missing) missing.add(name);
		out[key] = result.value;
	}
	return out;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry !== "string") return undefined;
		out[key] = entry;
	}
	return out;
}

export interface NormalizedServer {
	config?: McpServerConfig;
	error?: string;
	warnings: string[];
}

/** Normalize one raw `mcpServers` entry, mirroring Claude Code's rules. */
export function normalizeServerConfig(name: string, raw: unknown, env: NodeJS.ProcessEnv = process.env): NormalizedServer {
	const warnings: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: `MCP server "${name}" must be a JSON object`, warnings };
	}
	const entry = raw as Record<string, unknown>;
	let type = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;
	if (type === "streamable-http") type = "http";
	if (type === undefined) {
		if (typeof entry.command === "string") type = "stdio";
		else if (typeof entry.url === "string") {
			return { error: `MCP server "${name}" has a "url" but no "type"; add "type": "http" (or "sse") to this entry`, warnings };
		} else {
			return { error: `MCP server "${name}" needs either a "command" (stdio) or a "type" and "url" (remote)`, warnings };
		}
	}
	if (type === "ws") {
		return { error: `MCP server "${name}" uses the WebSocket transport, which the harness does not support; use "http" instead`, warnings };
	}
	if (type !== "stdio" && type !== "http" && type !== "sse") {
		return { error: `MCP server "${name}" has unknown transport type "${String(entry.type)}"`, warnings };
	}
	const missing = new Set<string>();
	let timeout: number | undefined;
	if (entry.timeout !== undefined) {
		if (typeof entry.timeout === "number" && Number.isFinite(entry.timeout) && entry.timeout >= MIN_SERVER_TIMEOUT_MS) timeout = entry.timeout;
		else warnings.push(`MCP server "${name}": "timeout" below ${MIN_SERVER_TIMEOUT_MS}ms (or invalid) is ignored`);
	}

	if (type === "stdio") {
		if (typeof entry.command !== "string" || !entry.command.trim()) {
			return { error: `MCP server "${name}" (stdio) requires a "command" string`, warnings };
		}
		const rawArgs = entry.args === undefined ? [] : entry.args;
		if (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== "string")) {
			return { error: `MCP server "${name}" (stdio) "args" must be an array of strings`, warnings };
		}
		const rawEnv = entry.env === undefined ? {} : stringRecord(entry.env);
		if (!rawEnv) return { error: `MCP server "${name}" (stdio) "env" must be an object of string values`, warnings };
		const command = expandVariables(entry.command, env);
		for (const variable of command.missing) missing.add(variable);
		const args = (rawArgs as string[]).map((arg) => {
			const result = expandVariables(arg, env);
			for (const variable of result.missing) missing.add(variable);
			return result.value;
		});
		const envVars = expandRecord(rawEnv, env, missing);
		if (missing.size) warnings.push(`MCP server "${name}": environment variable(s) not set: ${[...missing].join(", ")} (left unexpanded)`);
		const cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
		return { config: { type: "stdio", command: command.value, args, env: envVars, cwd, timeout }, warnings };
	}

	if (typeof entry.url !== "string" || !entry.url.trim()) {
		return { error: `MCP server "${name}" (${type}) requires a "url" string`, warnings };
	}
	const url = expandVariables(entry.url, env);
	for (const variable of url.missing) missing.add(variable);
	const rawHeaders = entry.headers === undefined ? {} : stringRecord(entry.headers);
	if (!rawHeaders) return { error: `MCP server "${name}" (${type}) "headers" must be an object of string values`, warnings };
	const headers = expandRecord(rawHeaders, env, missing);
	if (missing.size) warnings.push(`MCP server "${name}": environment variable(s) not set: ${[...missing].join(", ")} (left unexpanded)`);
	try {
		const parsed = new URL(url.value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { error: `MCP server "${name}" URL must be http(s), got "${parsed.protocol}"`, warnings };
		}
	} catch {
		return { error: `MCP server "${name}" has an invalid URL: ${url.value}`, warnings };
	}
	return { config: { type, url: url.value, headers, timeout }, warnings };
}

/** Parse a `{ "mcpServers": { ... } }` document. */
export function parseMcpDocument(text: string): { servers: Record<string, unknown>; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { servers: {}, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { servers: {}, error: "config root must be a JSON object" };
	const servers = (parsed as { mcpServers?: unknown }).mcpServers;
	if (servers === undefined) return { servers: {} };
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { servers: {}, error: `"mcpServers" must be a JSON object` };
	return { servers: servers as Record<string, unknown> };
}

export interface ScopedServers {
	scope: McpScope;
	servers: Record<string, unknown>;
}

/**
 * Merge server definitions across scopes with Claude Code precedence:
 * local > project > user. The whole entry from the winning scope is used.
 */
export function mergeServerScopes(scopes: ScopedServers[], env: NodeJS.ProcessEnv = process.env): { entries: McpServerEntry[]; warnings: string[] } {
	const precedence: Record<McpScope, number> = { local: 3, project: 2, user: 1 };
	const winners = new Map<string, { scope: McpScope; raw: unknown }>();
	for (const { scope, servers } of scopes) {
		for (const [name, raw] of Object.entries(servers)) {
			const existing = winners.get(name);
			if (!existing || precedence[scope] > precedence[existing.scope]) winners.set(name, { scope, raw });
		}
	}
	const entries: McpServerEntry[] = [];
	const warnings: string[] = [];
	for (const [name, { scope, raw }] of winners) {
		const normalized = normalizeServerConfig(name, raw, env);
		warnings.push(...normalized.warnings);
		if (normalized.error) {
			warnings.push(normalized.error);
			continue;
		}
		if (normalized.config) entries.push({ name, scope, config: normalized.config, raw });
	}
	return { entries, warnings };
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** Stable hash of a raw server config, used to pin project-server approvals. */
export function configHash(raw: unknown): string {
	return createHash("sha256").update(stableStringify(raw)).digest("hex");
}

/* ------------------------------------------------------------------ *
 * Naming, output limits, content conversion
 * ------------------------------------------------------------------ */

/** Replace characters outside [A-Za-z0-9_-] with "_" (Claude Code parity). */
export function sanitizeName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Full callable tool name: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool: string): string {
	return `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`;
}

/** Prompt command name: `mcp__<server>__<prompt>` (invoked as /mcp__...). */
export function mcpPromptCommandName(server: string, prompt: string): string {
	return `mcp__${sanitizeName(server)}__${sanitizeName(prompt)}`;
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function limitToolOutput(text: string, maxTokens: number): { text: string; truncated: boolean; estimatedTokens: number } {
	const estimatedTokens = estimateTokens(text);
	if (estimatedTokens <= maxTokens) return { text, truncated: false, estimatedTokens };
	const kept = text.slice(0, Math.max(0, maxTokens * 4));
	return {
		text: `${kept}\n\n[MCP tool output truncated: ~${estimatedTokens} tokens exceeded the ~${maxTokens} token limit (set MAX_MCP_OUTPUT_TOKENS to raise it)]`,
		truncated: true,
		estimatedTokens,
	};
}

export type PiToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Convert MCP `tools/call` content blocks into pi tool-result content. */
export function convertMcpContent(content: unknown, structuredContent?: unknown): PiToolContent[] {
	const out: PiToolContent[] = [];
	const blocks = Array.isArray(content) ? content : [];
	for (const raw of blocks) {
		const block = raw as Record<string, unknown>;
		switch (block?.type) {
			case "text":
				out.push({ type: "text", text: String(block.text ?? "") });
				break;
			case "image":
				if (typeof block.data === "string" && typeof block.mimeType === "string") {
					out.push({ type: "image", data: block.data, mimeType: block.mimeType });
				}
				break;
			case "audio":
				out.push({ type: "text", text: `[audio content: ${String(block.mimeType ?? "unknown type")}, not supported]` });
				break;
			case "resource_link":
				out.push({ type: "text", text: `[resource link] ${String(block.uri ?? "")}${block.name ? ` (${String(block.name)})` : ""}${block.description ? `: ${String(block.description)}` : ""}` });
				break;
			case "resource": {
				const resource = (block.resource ?? {}) as Record<string, unknown>;
				if (typeof resource.text === "string") {
					out.push({ type: "text", text: `[resource ${String(resource.uri ?? "")}]\n${resource.text}` });
				} else if (typeof resource.blob === "string" && typeof resource.mimeType === "string" && resource.mimeType.startsWith("image/")) {
					out.push({ type: "image", data: resource.blob, mimeType: resource.mimeType });
				} else {
					out.push({ type: "text", text: `[binary resource ${String(resource.uri ?? "")} (${String(resource.mimeType ?? "unknown type")})]` });
				}
				break;
			}
			default:
				if (block !== null && block !== undefined) out.push({ type: "text", text: JSON.stringify(block) });
		}
	}
	if (!out.length && structuredContent !== undefined) {
		out.push({ type: "text", text: JSON.stringify(structuredContent, null, 2) });
	}
	if (!out.length) out.push({ type: "text", text: "(no content)" });
	return out;
}

/** Ensure a usable JSON-Schema object for pi tool parameters. */
export function toolParametersSchema(inputSchema: unknown): Record<string, unknown> {
	if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
		const schema = inputSchema as Record<string, unknown>;
		if (schema.type === "object" || schema.properties !== undefined) return { type: "object", ...schema };
	}
	return { type: "object", properties: {} };
}

/* ------------------------------------------------------------------ *
 * SSE parsing (shared by streamable HTTP and legacy SSE transports)
 * ------------------------------------------------------------------ */

export interface SseEvent {
	event: string;
	data: string;
	id?: string;
}

/** Incremental Server-Sent Events parser (handles chunk splits and CRLF). */
export class SseParser {
	private buffer = "";
	private dataLines: string[] = [];
	private eventType = "";
	private lastId: string | undefined;

	push(chunk: string): SseEvent[] {
		this.buffer += chunk;
		const events: SseEvent[] = [];
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) break;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line === "") {
				if (this.dataLines.length) {
					events.push({ event: this.eventType || "message", data: this.dataLines.join("\n"), id: this.lastId });
				}
				this.dataLines = [];
				this.eventType = "";
				continue;
			}
			if (line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "data") this.dataLines.push(value);
			else if (field === "event") this.eventType = value;
			else if (field === "id" && !value.includes("\0")) this.lastId = value;
		}
		return events;
	}
}

/* ------------------------------------------------------------------ *
 * JSON-RPC plumbing
 * ------------------------------------------------------------------ */

export type JsonRpcId = string | number;
export interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: JsonRpcId | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface McpTransport {
	start(): Promise<void>;
	send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
	onmessage?: (message: JsonRpcMessage) => void;
	onclose?: (reason?: string) => void;
	/** Streamable HTTP: called with the negotiated protocol version after init. */
	setProtocolVersion?(version: string): void;
	/** Streamable HTTP: open the optional GET listener stream. */
	openListener?(): void;
	/** Diagnostics (stdio stderr tail, HTTP status notes, ...). */
	diagnostics?(): string;
}

function parseJsonRpc(text: string): JsonRpcMessage | undefined {
	try {
		const parsed = JSON.parse(text) as JsonRpcMessage;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/* ------------------------------------------------------------------ *
 * stdio transport
 * ------------------------------------------------------------------ */

export interface StdioTransportOptions {
	command: string;
	args: string[];
	env: Record<string, string | undefined>;
	cwd?: string;
	stderrLimit?: number;
}

export class StdioTransport implements McpTransport {
	onmessage?: (message: JsonRpcMessage) => void;
	onclose?: (reason?: string) => void;
	private child?: ChildProcess;
	private stdoutBuffer = "";
	private stderrTail = "";
	private closed = false;
	private readonly options: StdioTransportOptions;

	constructor(options: StdioTransportOptions) {
		this.options = options;
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.options.command, this.options.args, {
				cwd: this.options.cwd,
				env: this.options.env as NodeJS.ProcessEnv,
				stdio: ["pipe", "pipe", "pipe"],
				shell: process.platform === "win32",
			});
			this.child = child;
			let settled = false;
			child.once("spawn", () => {
				settled = true;
				resolve();
			});
			child.once("error", (error) => {
				if (!settled) {
					settled = true;
					reject(new Error(`failed to launch "${this.options.command}": ${error.message}`));
				}
				this.emitClose(`process error: ${error.message}`);
			});
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				const limit = this.options.stderrLimit ?? 4_000;
				this.stderrTail = (this.stderrTail + chunk).slice(-limit);
			});
			child.once("exit", (code, signal) => {
				this.emitClose(`process exited (${signal ?? `code ${code}`})`);
			});
		});
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		for (;;) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline === -1) break;
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			const message = parseJsonRpc(line);
			if (message) this.onmessage?.(message);
		}
	}

	private emitClose(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.onclose?.(reason);
	}

	async send(message: JsonRpcMessage): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) throw new Error("MCP stdio transport is not connected");
		await new Promise<void>((resolve, reject) => {
			stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		child.stdin?.end();
		await new Promise<void>((resolve) => {
			const killTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 2_000);
			killTimer.unref?.();
			child.once("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}

	diagnostics(): string {
		return this.stderrTail.trim();
	}
}

/* ------------------------------------------------------------------ *
 * Streamable HTTP transport
 * ------------------------------------------------------------------ */

export interface HttpTransportOptions {
	url: string;
	headers: Record<string, string>;
}

export class StreamableHttpTransport implements McpTransport {
	onmessage?: (message: JsonRpcMessage) => void;
	onclose?: (reason?: string) => void;
	private sessionId: string | undefined;
	private protocolVersion: string | undefined;
	private readonly closeController = new AbortController();
	private closed = false;
	private note = "";
	private readonly options: HttpTransportOptions;

	constructor(options: HttpTransportOptions) {
		this.options = options;
	}

	async start(): Promise<void> {}

	setProtocolVersion(version: string): void {
		this.protocolVersion = version;
	}

	private requestHeaders(extra: Record<string, string>): Record<string, string> {
		const headers: Record<string, string> = { ...this.options.headers, ...extra };
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
		return headers;
	}

	async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
		if (this.closed) throw new Error("MCP HTTP transport is closed");
		const signals = signal ? AbortSignal.any([this.closeController.signal, signal]) : this.closeController.signal;
		const response = await fetch(this.options.url, {
			method: "POST",
			headers: this.requestHeaders({ "content-type": "application/json", accept: "application/json, text/event-stream" }),
			body: JSON.stringify(message),
			signal: signals,
		});
		const newSession = response.headers.get("mcp-session-id");
		if (newSession && message.method === "initialize") this.sessionId = newSession;
		if (response.status === 202) {
			await response.body?.cancel().catch(() => {});
			return;
		}
		if (response.status === 404 && this.sessionId) {
			this.emitClose("HTTP session expired (404)");
			throw new Error("MCP HTTP session expired");
		}
		if (!response.ok) {
			const body = await response.text().then((text) => text.slice(0, 300)).catch(() => "");
			throw new Error(`MCP server returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
		}
		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
		if (contentType.includes("text/event-stream")) {
			void this.consumeSse(response, signals).catch(() => {});
			return;
		}
		if (contentType.includes("application/json")) {
			const payload = (await response.json().catch(() => undefined)) as JsonRpcMessage | JsonRpcMessage[] | undefined;
			for (const item of Array.isArray(payload) ? payload : payload ? [payload] : []) this.onmessage?.(item);
			return;
		}
		await response.body?.cancel().catch(() => {});
	}

	private async consumeSse(response: Response, signal: AbortSignal): Promise<void> {
		if (!response.body) return;
		const parser = new SseParser();
		const decoder = new TextDecoder();
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				for (const event of parser.push(decoder.decode(value, { stream: true }))) {
					if (event.event !== "message") continue;
					const message = parseJsonRpc(event.data);
					if (message) this.onmessage?.(message);
				}
				if (signal.aborted) break;
			}
		} finally {
			reader.releaseLock?.();
		}
	}

	/** Optional GET stream for unsolicited server messages; 405/404 means unsupported. */
	openListener(): void {
		void (async () => {
			try {
				const response = await fetch(this.options.url, {
					method: "GET",
					headers: this.requestHeaders({ accept: "text/event-stream" }),
					signal: this.closeController.signal,
				});
				if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
					await response.body?.cancel().catch(() => {});
					return;
				}
				await this.consumeSse(response, this.closeController.signal);
			} catch {
				/* listener stream is best-effort */
			}
		})();
	}

	private emitClose(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.onclose?.(reason);
	}

	async close(): Promise<void> {
		if (this.closed) {
			this.closeController.abort();
			return;
		}
		this.closed = true;
		if (this.sessionId) {
			await fetch(this.options.url, {
				method: "DELETE",
				headers: this.requestHeaders({}),
				signal: AbortSignal.timeout(3_000),
			}).then((response) => response.body?.cancel().catch(() => {})).catch(() => {});
		}
		this.closeController.abort();
	}

	diagnostics(): string {
		return this.note;
	}
}

/* ------------------------------------------------------------------ *
 * Legacy SSE transport (deprecated in MCP, kept for compatibility)
 * ------------------------------------------------------------------ */

export class SseTransport implements McpTransport {
	onmessage?: (message: JsonRpcMessage) => void;
	onclose?: (reason?: string) => void;
	private endpoint: string | undefined;
	private readonly closeController = new AbortController();
	private closed = false;
	private readonly options: HttpTransportOptions & { startupTimeoutMs?: number };

	constructor(options: HttpTransportOptions & { startupTimeoutMs?: number }) {
		this.options = options;
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
			let settled = false;
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					reject(new Error(`SSE endpoint event not received within ${timeoutMs}ms`));
				}
			}, timeoutMs);
			timer.unref?.();
			void (async () => {
				try {
					const response = await fetch(this.options.url, {
						method: "GET",
						headers: { ...this.options.headers, accept: "text/event-stream" },
						signal: this.closeController.signal,
					});
					if (!response.ok) throw new Error(`MCP SSE server returned HTTP ${response.status}`);
					if (!response.body) throw new Error("MCP SSE server returned no body");
					const parser = new SseParser();
					const decoder = new TextDecoder();
					const reader = response.body.getReader();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						for (const event of parser.push(decoder.decode(value, { stream: true }))) {
							if (event.event === "endpoint") {
								this.endpoint = new URL(event.data, this.options.url).toString();
								if (!settled) {
									settled = true;
									clearTimeout(timer);
									resolve();
								}
							} else if (event.event === "message") {
								const message = parseJsonRpc(event.data);
								if (message) this.onmessage?.(message);
							}
						}
					}
					this.emitClose("SSE stream ended");
				} catch (error) {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						reject(error instanceof Error ? error : new Error(String(error)));
					}
					this.emitClose(error instanceof Error ? error.message : String(error));
				}
			})();
		});
	}

	async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
		if (!this.endpoint) throw new Error("MCP SSE transport has no endpoint yet");
		const signals = signal ? AbortSignal.any([this.closeController.signal, signal]) : this.closeController.signal;
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: { ...this.options.headers, "content-type": "application/json" },
			body: JSON.stringify(message),
			signal: signals,
		});
		await response.body?.cancel().catch(() => {});
		if (!response.ok) throw new Error(`MCP SSE server rejected message with HTTP ${response.status}`);
	}

	private emitClose(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.onclose?.(reason);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.closeController.abort();
	}
}

/* ------------------------------------------------------------------ *
 * MCP client
 * ------------------------------------------------------------------ */

export interface McpServerCapabilities {
	tools?: { listChanged?: boolean };
	prompts?: { listChanged?: boolean };
	resources?: { listChanged?: boolean; subscribe?: boolean };
	[key: string]: unknown;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
	title?: string;
}

export interface McpPromptInfo {
	name: string;
	description?: string;
	arguments?: Array<{ name: string; description?: string; required?: boolean }>;
	title?: string;
}

export interface McpResourceInfo {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export interface McpCallResult {
	content: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

export interface McpClientOptions {
	transport: McpTransport;
	clientName?: string;
	clientVersion?: string;
	/** Workspace root exposed via `roots/list`. */
	rootPath?: string;
	defaultTimeoutMs?: number;
	onNotification?: (method: string, params: unknown) => void;
	onClose?: (reason?: string) => void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
	cleanup?: () => void;
}

export class McpClient {
	serverInfo: { name?: string; version?: string } = {};
	capabilities: McpServerCapabilities = {};
	instructions: string | undefined;
	protocolVersion: string | undefined;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private nextId = 1;
	private closed = false;
	private readonly options: McpClientOptions;

	constructor(options: McpClientOptions) {
		this.options = options;
		options.transport.onmessage = (message) => this.handleMessage(message);
		options.transport.onclose = (reason) => {
			this.failPending(new Error(`MCP connection closed${reason ? `: ${reason}` : ""}`));
			if (!this.closed) {
				this.closed = true;
				this.options.onClose?.(reason);
			}
		};
	}

	get transport(): McpTransport {
		return this.options.transport;
	}

	async connect(timeoutMs: number): Promise<void> {
		await this.options.transport.start();
		const result = (await this.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: { roots: { listChanged: false } },
			clientInfo: { name: this.options.clientName ?? "pi-audited-harness", version: this.options.clientVersion ?? "0.2.0" },
		}, { timeoutMs })) as { protocolVersion?: string; capabilities?: McpServerCapabilities; serverInfo?: { name?: string; version?: string }; instructions?: string };
		this.protocolVersion = result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
		this.capabilities = result?.capabilities ?? {};
		this.serverInfo = result?.serverInfo ?? {};
		this.instructions = typeof result?.instructions === "string" ? result.instructions : undefined;
		this.options.transport.setProtocolVersion?.(this.protocolVersion);
		await this.notify("notifications/initialized");
		this.options.transport.openListener?.();
	}

	request(method: string, params?: unknown, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("MCP client is closed"));
		const id = this.nextId++;
		const timeoutMs = options?.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
		return new Promise<unknown>((resolve, reject) => {
			const entry: PendingRequest = { resolve, reject };
			const settle = (callback: (value: never) => void) => (value: never) => {
				if (entry.timer) clearTimeout(entry.timer);
				entry.cleanup?.();
				this.pending.delete(id);
				callback(value);
			};
			entry.resolve = settle(resolve as (value: never) => void) as (value: unknown) => void;
			entry.reject = settle(reject as (value: never) => void) as (error: Error) => void;
			entry.timer = setTimeout(() => {
				entry.reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
				void this.notify("notifications/cancelled", { requestId: id, reason: "timeout" }).catch(() => {});
			}, timeoutMs);
			entry.timer.unref?.();
			if (options?.signal) {
				const signal = options.signal;
				if (signal.aborted) {
					entry.reject(new Error(`MCP request "${method}" was cancelled`));
					return;
				}
				const onAbort = () => {
					entry.reject(new Error(`MCP request "${method}" was cancelled`));
					void this.notify("notifications/cancelled", { requestId: id, reason: "user cancelled" }).catch(() => {});
				};
				signal.addEventListener("abort", onAbort, { once: true });
				entry.cleanup = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.set(id, entry);
			this.options.transport.send({ jsonrpc: "2.0", id, method, params }, options?.signal).catch((error) => {
				entry.reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.options.transport.send({ jsonrpc: "2.0", method, params });
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (message.method !== undefined && message.id !== undefined && message.id !== null) {
			void this.handleServerRequest(message.id, message.method);
			return;
		}
		if (message.method !== undefined) {
			this.options.onNotification?.(message.method, message.params);
			return;
		}
		if (message.id === undefined || message.id === null) return;
		const entry = this.pending.get(message.id);
		if (!entry) return;
		if (message.error) entry.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
		else entry.resolve(message.result);
	}

	private async handleServerRequest(id: JsonRpcId, method: string): Promise<void> {
		try {
			if (method === "ping") {
				await this.options.transport.send({ jsonrpc: "2.0", id, result: {} });
			} else if (method === "roots/list") {
				const roots = this.options.rootPath
					? [{ uri: new URL(`file://${this.options.rootPath.replaceAll("\\", "/")}`).toString(), name: "workspace" }]
					: [];
				await this.options.transport.send({ jsonrpc: "2.0", id, result: { roots } });
			} else {
				await this.options.transport.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not supported: ${method}` } });
			}
		} catch {
			/* responses to server requests are best-effort */
		}
	}

	private failPending(error: Error): void {
		for (const entry of [...this.pending.values()]) entry.reject(error);
		this.pending.clear();
	}

	private async paginate<T>(method: string, key: string, timeoutMs?: number): Promise<T[]> {
		const items: T[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 50; page++) {
			const result = (await this.request(method, cursor ? { cursor } : {}, { timeoutMs })) as Record<string, unknown> | undefined;
			const chunk = result?.[key];
			if (Array.isArray(chunk)) items.push(...(chunk as T[]));
			cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
			if (!cursor) break;
		}
		return items;
	}

	listTools(timeoutMs?: number): Promise<McpToolInfo[]> {
		return this.paginate<McpToolInfo>("tools/list", "tools", timeoutMs);
	}

	async callTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<McpCallResult> {
		const result = await this.request("tools/call", { name, arguments: args }, options);
		return (result ?? {}) as McpCallResult;
	}

	listPrompts(timeoutMs?: number): Promise<McpPromptInfo[]> {
		return this.paginate<McpPromptInfo>("prompts/list", "prompts", timeoutMs);
	}

	async getPrompt(name: string, args: Record<string, string>, timeoutMs?: number): Promise<{ description?: string; messages?: Array<{ role?: string; content?: unknown }> }> {
		return (await this.request("prompts/get", { name, arguments: args }, { timeoutMs })) as { description?: string; messages?: Array<{ role?: string; content?: unknown }> };
	}

	listResources(timeoutMs?: number): Promise<McpResourceInfo[]> {
		return this.paginate<McpResourceInfo>("resources/list", "resources", timeoutMs);
	}

	async readResource(uri: string, timeoutMs?: number): Promise<{ contents?: Array<Record<string, unknown>> }> {
		return (await this.request("resources/read", { uri }, { timeoutMs })) as { contents?: Array<Record<string, unknown>> };
	}

	async close(): Promise<void> {
		this.closed = true;
		this.failPending(new Error("MCP client closed"));
		await this.options.transport.close();
	}
}

/* ------------------------------------------------------------------ *
 * `/mcp add` argument parsing
 * ------------------------------------------------------------------ */

/** Shell-like tokenizer for /mcp command arguments (quotes and backslashes). */
export function tokenize(line: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let hasToken = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			hasToken = true;
			continue;
		}
		if (char === "\\" && index + 1 < line.length) {
			current += line[++index];
			hasToken = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (hasToken || current) tokens.push(current);
			current = "";
			hasToken = false;
			continue;
		}
		current += char;
		hasToken = true;
	}
	if (hasToken || current) tokens.push(current);
	return tokens;
}

export interface ParsedAddCommand {
	name?: string;
	scope: McpScope;
	raw?: Record<string, unknown>;
	error?: string;
}

/**
 * Parse `/mcp add` arguments in Claude Code CLI style:
 *   add [--transport stdio|http|sse] [--scope local|project|user]
 *       [--env K=V]... [--header "K: V"]... [--timeout ms] <name> <url> | <name> -- <command> [args...]
 */
export function parseAddArgs(tokens: string[]): ParsedAddCommand {
	let transport: string | undefined;
	let scope: McpScope = "local";
	const env: Record<string, string> = {};
	const headers: Record<string, string> = {};
	let timeout: number | undefined;
	const positional: string[] = [];
	let command: string[] | undefined;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--") {
			command = tokens.slice(index + 1);
			break;
		}
		if (token === "--transport" || token === "-t") {
			transport = tokens[++index]?.toLowerCase();
			continue;
		}
		if (token === "--scope" || token === "-s") {
			const value = tokens[++index]?.toLowerCase();
			if (!MCP_SCOPES.includes(value as McpScope)) return { scope, error: `invalid scope "${value ?? ""}" (expected local, project, or user)` };
			scope = value as McpScope;
			continue;
		}
		if (token === "--env" || token === "-e") {
			const pair = tokens[++index] ?? "";
			const equals = pair.indexOf("=");
			if (equals <= 0) return { scope, error: `invalid --env value "${pair}" (expected KEY=value)` };
			env[pair.slice(0, equals)] = pair.slice(equals + 1);
			continue;
		}
		if (token === "--header" || token === "-H") {
			const header = tokens[++index] ?? "";
			const colon = header.indexOf(":");
			if (colon <= 0) return { scope, error: `invalid --header value "${header}" (expected "Name: value")` };
			headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
			continue;
		}
		if (token === "--timeout") {
			timeout = Number(tokens[++index]);
			continue;
		}
		if (token.startsWith("-")) return { scope, error: `unknown option "${token}"` };
		positional.push(token);
	}

	const name = positional[0];
	if (!name) return { scope, error: "server name is required" };
	if (!/^[A-Za-z0-9_-]+$/.test(name)) return { scope, error: "server names may only contain letters, numbers, hyphens, and underscores" };

	if (command !== undefined) {
		if (transport && transport !== "stdio") return { scope, error: `transport "${transport}" does not take a command; pass a URL instead` };
		if (!command.length) return { scope, error: "expected a command after --" };
		const raw: Record<string, unknown> = { type: "stdio", command: command[0], args: command.slice(1) };
		if (Object.keys(env).length) raw.env = env;
		if (timeout !== undefined) raw.timeout = timeout;
		return { name, scope, raw };
	}

	const url = positional[1];
	if (!url) return { scope, error: "expected a URL (or `-- command args...` for stdio servers)" };
	if (!transport) transport = /^https?:\/\//i.test(url) ? "http" : undefined;
	if (transport === "streamable-http") transport = "http";
	if (transport !== "http" && transport !== "sse") {
		return { scope, error: `cannot infer transport for "${url}"; pass --transport http|sse or use \`-- command\` for stdio` };
	}
	const raw: Record<string, unknown> = { type: transport, url };
	if (Object.keys(headers).length) raw.headers = headers;
	if (timeout !== undefined) raw.timeout = timeout;
	return { name, scope, raw };
}
