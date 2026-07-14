/**
 * Sub-agent framework extension.
 *
 * Ports Claude Code's sub-agent design into the audited harness:
 * - The parent agent dispatches a **sub-agent** — a specialized agent running in
 *   its own isolated conversation, with its own system prompt, tools, and model —
 *   via the `subagent` tool, and receives back only that sub-agent's final result.
 * - Users define reusable agents as Markdown files (YAML frontmatter + body) under
 *   `.pi/agents/` (project, trusted only) and `~/.pi/agent/agents/` (global).
 * - Three tools are exposed to the parent LLM: `subagent` (dispatch/resume/fork),
 *   `get_subagent_result` (background poll/wait), and `steer_subagent` (mid-run
 *   steering). Built-in types `general-purpose`, `Explore`, `Plan` ship with the
 *   harness and can be overridden by name (matched case-insensitively).
 *
 * **Safety is structural, not by convention.** Every tool call made *inside* a
 * sub-agent is classified by the harness's existing rule functions from
 * `extensions/policy-rules.ts` against the parent's active mode, via a tiny inline
 * extension attached to the sub-agent's isolated session. Delegating work to a
 * sub-agent therefore can never bypass the harness policy — a sub-agent that
 * attempts a prohibited write, a destructive command, or a confirm-category action
 * is blocked or approval-gated exactly as the parent would be, with approvals
 * surfaced in the parent session's UI.
 *
 * Sub-agents run in an isolated in-process session with `noExtensions` so the
 * harness extensions (including this one) are not re-entered; their tool set is the
 * built-in coding tools, restricted by the agent's `tools` allowlist and the active
 * mode, plus the dispatch tools when nesting is allowed (depth < cap). The agent
 * definition's body is appended to Pi's baseline system prompt so the sub-agent
 * keeps tool/guideline docs while gaining its specialized instructions.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	parseFrontmatter,
	createAgentSession,
	SessionManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	classifyCommand,
	classifyCustomTool,
	classifyFileTool,
	isHarnessMode,
	type Decision,
	type HarnessMode,
} from "./policy-rules.ts";

/* ------------------------------------------------------------------ *
 * Local types (defined locally to avoid a direct @earendil-works/    *
 * pi-agent-core import, which is not a harness dependency; the SDK's *
 * own typed accessors resolve its types transitively under tsc).     *
 * ------------------------------------------------------------------ */

/** Pi reasoning-effort levels. Mirrors `ThinkingLevel` from pi-agent-core. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Built-in coding tool names a sub-agent may use. */
export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
/** Read-only subset (used in inspect/plan and for Explore/Plan). */
export const READONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
/** Dispatch tool names (present below the depth cap). */
export const DISPATCH_TOOL_NAMES = ["subagent", "get_subagent_result", "steer_subagent"] as const;
/** Session entry used to persist the per-session enabled setting. */
export const SUBAGENT_SESSION_STATE_ENTRY = "audited-harness:subagents";

export interface SubagentSessionState {
	enabled: boolean;
	/** Dispatch tools that were active before the feature was disabled. */
	restoreTools: string[];
}

/** Restore the latest valid sub-agent setting from the active session branch. */
export function latestSubagentSessionState(entries: readonly unknown[]): SubagentSessionState | undefined {
	let state: SubagentSessionState | undefined;
	for (const value of entries) {
		const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_SESSION_STATE_ENTRY) continue;
		const data = entry.data as { enabled?: unknown; restoreTools?: unknown } | undefined;
		if (typeof data?.enabled !== "boolean" || !Array.isArray(data.restoreTools)) continue;
		state = {
			enabled: data.enabled,
			restoreTools: [...new Set(data.restoreTools.filter((tool): tool is string =>
				typeof tool === "string" && (DISPATCH_TOOL_NAMES as readonly string[]).includes(tool),
			))],
		};
	}
	return state;
}

/** Add or remove only the sub-agent tools without disturbing other active tools. */
export function updateSubagentTools(activeTools: readonly string[], enabled: boolean, restoreTools: readonly string[] = DISPATCH_TOOL_NAMES): string[] {
	const dispatchTools = DISPATCH_TOOL_NAMES as readonly string[];
	if (!enabled) return activeTools.filter((tool) => !dispatchTools.includes(tool));
	return [...new Set([
		...activeTools,
		...restoreTools.filter((tool) => dispatchTools.includes(tool)),
	])];
}

/** `name` must be lowercase/digits/hyphens (built-in names are an exception). */
export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export interface SubagentConfig {
	enabled: boolean;
	/** Project-scope agents discovery directory (`.pi/agents` or an env override). */
	projectDir: string;
	/** Global agents discovery directory (`~/.pi/agent/agents`). */
	globalDir: string;
	/** True when the project dir came from an explicit env override (bypasses trust). */
	customProjectDir: boolean;
	/** Default model spec from `PI_HARNESS_SUBAGENT_MODEL`, if set. */
	defaultModel?: string;
	/** Default turn cap (0 = uncapped). */
	maxTurns: number;
	/** Nesting depth cap. */
	maxDepth: number;
	/** Max concurrent background sub-agents. */
	maxConcurrency: number;
}

/**
 * Resolve sub-agent configuration from the environment. Mirrors the harness's
 * `PI_HARNESS_*` conventions (see `memory.ts`).
 */
export function resolveSubagentConfig(env: NodeJS.ProcessEnv, cwd: string): SubagentConfig {
	const rawDir = env.PI_HARNESS_AGENTS_DIR;
	let projectDir: string;
	let customProjectDir = false;
	if (rawDir && rawDir.trim()) {
		customProjectDir = true;
		const expanded = rawDir.startsWith("~/") ? join(homedir(), rawDir.slice(2)) : rawDir;
		projectDir = resolve(cwd, expanded);
	} else {
		projectDir = join(cwd, CONFIG_DIR_NAME, "agents");
	}
	const globalDir = join(getAgentDir(), "agents");
	const maxTurns = parseNonNegInt(env.PI_HARNESS_SUBAGENT_MAX_TURNS, 50);
	const maxDepth = Math.max(1, parseNonNegInt(env.PI_HARNESS_SUBAGENT_MAX_DEPTH, 5) || 5);
	const maxConcurrency = Math.max(1, parseNonNegInt(env.PI_HARNESS_SUBAGENT_MAX_CONCURRENCY, 5) || 5);
	const defaultModel = env.PI_HARNESS_SUBAGENT_MODEL?.trim() || undefined;
	const enabled = env.PI_HARNESS_DISABLE_SUBAGENTS !== "1";
	return { enabled, projectDir, globalDir, customProjectDir, defaultModel, maxTurns, maxDepth, maxConcurrency };
}

function parseNonNegInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n < 0) return fallback;
	return n;
}

/* ------------------------------------------------------------------ *
 * Agent definition parsing
 * ------------------------------------------------------------------ */

export interface AgentFrontmatter {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	max_turns?: unknown;
}

export interface AgentDefinition {
	/** Canonical name as authored (matched case-insensitively). */
	name: string;
	description: string;
	/** Markdown body — the agent's specialized system-prompt instructions. */
	systemPrompt: string;
	/** Declared tool allowlist (undefined = inherit default built-in set). */
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel | "inherit";
	maxTurns?: number;
	/** True for the framework's built-in agents. */
	builtin?: boolean;
	source: { path: string; scope: "project" | "global" | "builtin" };
}

export type ParseAgentResult =
	| { ok: true; def: AgentDefinition; warnings: string[] }
	| { ok: false; error: string; warnings: string[] };

const KNOWN_FIELDS = new Set(["name", "description", "tools", "model", "thinking", "max_turns"]);

/**
 * Parse a Markdown agent file (YAML frontmatter + body) into an
 * {@link AgentDefinition}. The body becomes the agent's system prompt.
 */
export function parseAgentFile(content: string, source: AgentDefinition["source"]): ParseAgentResult {
	const warnings: string[] = [];
	const parsed = parseFrontmatter(content);
	const frontmatter = (parsed.frontmatter ?? {}) as AgentFrontmatter;
	const body = parsed.body.trim();

	for (const key of Object.keys(frontmatter)) {
		if (!KNOWN_FIELDS.has(key)) warnings.push(`unknown field '${key}' ignored`);
	}

	const name = stringField(frontmatter.name);
	if (!name) return { ok: false, error: "missing required field 'name'", warnings };
	if (!NAME_PATTERN.test(name)) {
		return { ok: false, error: `'name' must be lowercase letters, digits, and hyphens (got '${name}')`, warnings };
	}
	const description = stringField(frontmatter.description);
	if (!description) return { ok: false, error: "missing required field 'description'", warnings };

	let tools: string[] | undefined;
	if (frontmatter.tools !== undefined) {
		const arr = asStringArray(frontmatter.tools);
		if (arr === null) return { ok: false, error: "'tools' must be a list of strings", warnings };
		tools = arr;
	}
	const model = frontmatter.model !== undefined ? stringField(frontmatter.model) : undefined;
	let thinking: ThinkingLevel | "inherit" | undefined;
	if (frontmatter.thinking !== undefined) {
		const t = stringField(frontmatter.thinking);
		if (t === "inherit") thinking = "inherit";
		else if (t && THINKING_LEVELS.has(t as ThinkingLevel)) thinking = t as ThinkingLevel;
		else return { ok: false, error: `'thinking' must be a level or 'inherit' (got '${t}')`, warnings };
	}
	let maxTurns: number | undefined;
	if (frontmatter.max_turns !== undefined) {
		const n = asNonNegInt(frontmatter.max_turns);
		if (n === null) return { ok: false, error: "'max_turns' must be a non-negative integer", warnings };
		maxTurns = n;
	}

	return {
		ok: true,
		warnings,
		def: { name, description, systemPrompt: body, tools, model, thinking, maxTurns, source },
	};
}

function stringField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.trim();
	return t || undefined;
}

function asStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return null;
		out.push(item);
	}
	return out;
}

function asNonNegInt(value: unknown): number | null {
	if (typeof value === "boolean" || value === null) return null;
	const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(n) || n < 0) return null;
	return n;
}

/* ------------------------------------------------------------------ *
 * Built-in agents
 * ------------------------------------------------------------------ */

export const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: "general-purpose",
		description:
			"General-purpose agent for complex, multi-step tasks that need exploration and modification. Use for any self-contained task requiring its own context.",
		systemPrompt:
			"You are a general-purpose sub-agent. Work autonomously to complete the task you were given, then return a concise summary of what you did and what you found. Do not ask for clarification unless truly blocked.",
		builtin: true,
		source: { path: "<builtin:general-purpose>", scope: "builtin" },
	},
	{
		name: "Explore",
		description:
			"Fast codebase exploration agent (read-only). Use to investigate a defined area of the codebase and return a compact digest — mapping a subsystem, tracing how something works, finding interfaces — without modifying anything.",
		systemPrompt:
			"You are a read-only exploration sub-agent. Investigate the codebase to answer the question, then return a compact, structured digest another agent can act on without reading the code itself. Never modify files.",
		tools: [...READONLY_TOOL_NAMES],
		builtin: true,
		source: { path: "<builtin:Explore>", scope: "builtin" },
	},
	{
		name: "Plan",
		description:
			"Software architect for implementation planning (read-only). Use to research the codebase and produce an implementation plan or design — never to write code.",
		systemPrompt:
			"You are a planning sub-agent. Research the codebase and produce a clear, structured implementation plan. Never modify files.",
		tools: [...READONLY_TOOL_NAMES],
		builtin: true,
		source: { path: "<builtin:Plan>", scope: "builtin" },
	},
];

/** One-shot built-ins that cannot be resumed. */
export const ONESHOT_TYPES = new Set(["explore", "plan"]);

/* ------------------------------------------------------------------ *
 * Discovery & merge
 * ------------------------------------------------------------------ */

/**
 * Find the repository root (git top-level) by walking up from `cwd`, falling back
 * to the filesystem root when not inside a git repo — matching Pi's own resource
 * walk.
 */
export function findRepoRoot(cwd: string): string {
	let dir = resolve(cwd);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) return dir; // filesystem root
		dir = parent;
	}
}

/** Recursively collect `*.md` files under a directory. Returns [] if missing. */
export function collectAgentFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(full);
		}
	};
	walk(dir);
	return out.sort();
}

export interface DiscoverResult {
	agents: AgentDefinition[];
	diagnostics: string[];
}

/**
 * Discover agent definitions from project and global scopes. Project files are
 * loaded only when `trusted` (unless the project dir came from an explicit env
 * override). Within the project scope, files closer to `cwd` win (merge order).
 */
export async function discoverAgents(config: SubagentConfig, cwd: string, trusted: boolean): Promise<DiscoverResult> {
	const diagnostics: string[] = [];
	const projectAgents: AgentDefinition[] = [];

	if (config.customProjectDir || trusted) {
		const root = findRepoRoot(cwd);
		const dirs: string[] = [];
		let dir = resolve(cwd);
		while (true) {
			dirs.push(join(dir, CONFIG_DIR_NAME, "agents"));
			if (dir === root) break;
			const parent = resolve(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
		// dirs[0] is closest to cwd (highest precedence) — load in that order.
		for (const d of dirs) {
			for (const file of collectAgentFiles(d)) {
				const parsed = loadFile(file, "project", diagnostics);
				if (parsed) projectAgents.push(parsed);
			}
		}
	}

	const globalAgents: AgentDefinition[] = [];
	for (const file of collectAgentFiles(config.globalDir)) {
		const parsed = loadFile(file, "global", diagnostics);
		if (parsed) globalAgents.push(parsed);
	}

	const merged = mergeAgents([projectAgents, globalAgents, BUILTIN_AGENTS]);
	return { agents: merged.agents, diagnostics: [...diagnostics, ...merged.diagnostics] };
}

function loadFile(path: string, scope: AgentDefinition["source"]["scope"], diagnostics: string[]): AgentDefinition | undefined {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		diagnostics.push(`failed to read ${relativePath(path)}: ${(error as Error).message}`);
		return undefined;
	}
	const result = parseAgentFile(content, { path, scope });
	if (!result.ok) {
		diagnostics.push(`${relativePath(path)}: ${result.error}`);
		return undefined;
	}
	for (const w of result.warnings) diagnostics.push(`${relativePath(path)}: ${w}`);
	return result.def;
}

function relativePath(path: string): string {
	try {
		return relative(process.cwd(), path) || path;
	} catch {
		return path;
	}
}

export interface MergeResult {
	agents: AgentDefinition[];
	diagnostics: string[];
}

/**
 * Merge agent lists by precedence (first list = highest). Names match
 * case-insensitively; the first definition seen for a name wins and a diagnostic
 * is recorded for later duplicates (within or across lists).
 */
export function mergeAgents(lists: AgentDefinition[][]): MergeResult {
	const diagnostics: string[] = [];
	const out: AgentDefinition[] = [];
	const byKey = new Map<string, AgentDefinition>();
	const sourceLabel = (a: AgentDefinition) => `${a.name} (${a.source.scope}:${a.source.path})`;
	for (const list of lists) {
		for (const def of list) {
			const key = def.name.toLowerCase();
			if (byKey.has(key)) {
				diagnostics.push(`duplicate agent '${def.name}' at ${def.source.path} ignored; using ${sourceLabel(byKey.get(key)!)}`);
				continue;
			}
			byKey.set(key, def);
			out.push(def);
		}
	}
	return { agents: out, diagnostics };
}

/** Case-insensitive lookup in a registry. */
export function findAgent(agents: AgentDefinition[], type: string): AgentDefinition | undefined {
	const key = type.trim().toLowerCase();
	return agents.find((a) => a.name.toLowerCase() === key);
}

/* ------------------------------------------------------------------ *
 * Effective tool set, model, thinking, turns
 * ------------------------------------------------------------------ */

export interface EffectiveToolsOpts {
	def: AgentDefinition;
	depth: number;
	maxDepth: number;
	mode: HarnessMode;
}

/**
 * Compute a sub-agent's effective tool set (REQ-009). An explicit `tools`
 * allowlist replaces the default built-in set; restricted modes keep only
 * read-only tools; dispatch tools are added when nesting is allowed.
 */
export function computeEffectiveTools(opts: EffectiveToolsOpts): { tools: string[]; error?: string } {
	const declared = opts.def.tools;
	const base: readonly string[] = Array.isArray(declared) ? declared : BUILTIN_TOOL_NAMES;
	let tools = base.filter((t) => (BUILTIN_TOOL_NAMES as readonly string[]).includes(t));
	if (opts.mode === "inspect" || opts.mode === "plan") {
		tools = tools.filter((t) => (READONLY_TOOL_NAMES as readonly string[]).includes(t));
	}
	if (opts.depth < opts.maxDepth) {
		tools = [...tools, ...DISPATCH_TOOL_NAMES];
	}
	tools = [...new Set(tools)];
	if (tools.length === 0) return { tools, error: "effective tool set is empty after restrictions" };
	return { tools };
}

export function resolveModelSpec(callModel: string | undefined, defModel: string | undefined, envModel: string | undefined): string | undefined {
	const spec = callModel ?? defModel ?? envModel;
	if (!spec) return undefined;
	return spec.trim().toLowerCase() === "inherit" ? undefined : spec;
}

export function resolveThinking(callThinking: string | undefined, defThinking: ThinkingLevel | "inherit" | undefined): ThinkingLevel | "inherit" {
	if (callThinking) {
		if (callThinking === "inherit") return "inherit";
		if (THINKING_LEVELS.has(callThinking as ThinkingLevel)) return callThinking as ThinkingLevel;
	}
	return defThinking ?? "inherit";
}

export function resolveMaxTurns(callTurns: number | undefined, defTurns: number | undefined, cfgMaxTurns: number): number {
	if (typeof callTurns === "number" && callTurns >= 0) return callTurns;
	if (typeof defTurns === "number" && defTurns >= 0) return defTurns;
	return cfgMaxTurns;
}

/* ------------------------------------------------------------------ *
 * System-prompt registry block & result helpers
 * ------------------------------------------------------------------ */

export const SUBAGENT_DECISION_GUIDANCE = `Invoke a subagent only for a clear reason

Useful reasons include:

1. **Capability specialization**
   The task requires a tool, model, domain skill, or data source the parent lacks.

2. **Parallelism**
   Several substantial tasks are independent and can run concurrently.

3. **Context isolation**
   A large body of material can be analyzed separately without polluting the parent’s working context.

4. **Independent verification**
   A second agent can challenge a conclusion, inspect code, or reproduce a result.

5. **Fault or permission isolation**
   Risky tools, untrusted inputs, or sensitive data should be handled within a constrained execution boundary.

Avoid delegation when the task is trivial, requires constant back-and-forth with the parent, cannot be independently validated, or costs more to describe and integrate than to perform directly.

A useful decision rule is:

> Delegate when the expected improvement in quality, latency, or isolation exceeds the cost of specification, execution, and verification.`;

export function buildAgentsPrompt(agents: AgentDefinition[], opts: { depth: number; maxDepth: number }): string {
	if (opts.depth >= opts.maxDepth) return "";
	const lines: string[] = [
		"## Sub-agents",
		"",
		"Launch a specialized agent for complex, multi-step tasks. The sub-agent runs in its own isolated context and returns only its final result; its intermediate tool output stays out of your context.",
		"",
		SUBAGENT_DECISION_GUIDANCE,
		"",
		"Available agent types (`subagent_type`, matched case-insensitively):",
	];
	for (const a of agents) {
		lines.push(`- \`${a.name}\` — ${a.description}`);
	}
	lines.push(
		"",
		"`subagent` dispatches (foreground blocks until done; `run_in_background: true` returns an agent ID to poll with `get_subagent_result`). Use `inherit_context: true` to fork your conversation into the sub-agent, and `resume: <id>` to continue one. Steer a running sub-agent with `steer_subagent`. Sub-agents honor the active harness safety policy.",
	);
	return lines.join("\n");
}

export function generateAgentId(): string {
	return `sa_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Extract the last assistant text from a message list (defensively typed). */
export function extractFinalText(messages: readonly { role: string; content: unknown }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && (c as { type?: string }).type === "text")
				.map((c) => c.text)
				.join("");
			if (text.trim()) return text;
		}
	}
	return "";
}

/* ------------------------------------------------------------------ *
 * Run handle & policy-gating inline extension
 * ------------------------------------------------------------------ */

export type RunStatus = "running" | "completed" | "errored" | "aborted";

export interface AgentRun {
	id: string;
	type: string;
	depth: number;
	background: boolean;
	status: RunStatus;
	finalText?: string;
	error?: string;
	startedAt: number;
	session?: AgentSession;
	/** Resolves when the run finishes (success/error/abort). */
	done: Promise<void>;
}

/**
 * Count runs whose status is still "running" (the active sub-agents). Extracted as
 * a pure helper so the footer count is unit-testable without an SDK runner.
 */
export function countActiveRuns(runs: Iterable<Pick<AgentRun, "status">>): number {
	let n = 0;
	for (const r of runs) if (r.status === "running") n++;
	return n;
}

interface GateHooks {
	mode: HarnessMode;
	cwd: string;
	ui: ExtensionContext["ui"];
	hasUI: boolean;
	approvals: Set<string>;
	audit: (entry: { outcome: "approved" | "blocked"; category: string; tool: string; scope?: "once" | "session" }) => void;
}

/**
 * Build the inline extension that enforces the harness policy inside an isolated
 * sub-agent session. Every sub-agent tool call is classified by the shared rule
 * functions; blocks and confirm-category denials stop the call, and confirm
 * prompts surface in the parent session's UI.
 */
export function makeGatingExtension(hooks: GateHooks): InlineExtension {
	return {
		name: "subagent-policy-gate",
		factory: (pi) => {
			pi.on("tool_call", async (event) => {
				const tool = event.toolName;
				const input = event.input as Record<string, unknown> | undefined;
				let decision: Decision;
				if (tool === "bash") {
					decision = classifyCommand(hooks.mode, String(input?.command ?? ""), hooks.cwd);
				} else if ((["read", "write", "edit", "grep", "find", "ls"] as const).includes(tool as "read")) {
					decision = classifyFileTool(hooks.mode, tool, hooks.cwd, String(input?.path ?? "."));
				} else {
					decision = classifyCustomTool(hooks.mode, tool, hooks.cwd, input);
				}
				if (decision.action === "allow") return undefined;
				if (decision.action === "block") {
					hooks.audit({ outcome: "blocked", category: decision.category, tool });
					return { block: true as const, reason: `Safety policy: ${decision.reason}` };
				}
				// confirm
				if (hooks.approvals.has(decision.category)) {
					hooks.audit({ outcome: "approved", category: decision.category, tool, scope: "session" });
					return undefined;
				}
				if (!hooks.hasUI) {
					hooks.audit({ outcome: "blocked", category: decision.category, tool });
					return { block: true as const, reason: `Approval required but no UI available: ${decision.reason}` };
				}
				const choice = await hooks.ui.select(
					`Approve ${decision.category.replaceAll("-", " ")}? (sub-agent: ${tool})`,
					[`Allow once — ${decision.reason}`, "Allow this category for the sub-agent run", "Deny"],
				);
				if (choice?.startsWith("Allow this category")) {
					hooks.approvals.add(decision.category);
					hooks.audit({ outcome: "approved", category: decision.category, tool, scope: "session" });
					return undefined;
				}
				if (choice?.startsWith("Allow once")) {
					hooks.audit({ outcome: "approved", category: decision.category, tool, scope: "once" });
					return undefined;
				}
				hooks.audit({ outcome: "blocked", category: decision.category, tool });
				return { block: true as const, reason: `Declined: ${decision.reason}` };
			});
		},
	};
}

/* ------------------------------------------------------------------ *
 * Tool parameter schemas
 * ------------------------------------------------------------------ */

const SubagentParameters = Type.Object({
	prompt: Type.String({ description: "The task for the agent to perform." }),
	description: Type.Optional(Type.String({ description: "A short (3-5 word) task label shown in the UI." })),
	subagent_type: Type.Optional(Type.String({ description: "Agent name (built-in or discovered). Default general-purpose." })),
	model: Type.Optional(Type.String({ description: "Optional model override (provider/modelId or alias)." })),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "inherit"])),
	max_turns: Type.Optional(Type.Integer({ description: "Maximum agentic turns for this run." })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Return an agent ID immediately without blocking." })),
	resume: Type.Optional(Type.String({ description: "Agent ID to resume with a new prompt." })),
	inherit_context: Type.Optional(Type.Boolean({ description: "Fork the parent conversation into the sub-agent." })),
});

const GetResultParameters = Type.Object({
	agent_id: Type.String(),
	wait: Type.Optional(Type.Boolean({ description: "Block until the agent finishes (default false)." })),
	verbose: Type.Optional(Type.Boolean({ description: "Include the agent's full transcript (default false)." })),
});

const SteerParameters = Type.Object({
	agent_id: Type.String(),
	message: Type.String(),
});

/** Default sub-agent type when `subagent_type` is omitted. */
const DEFAULT_TYPE = "general-purpose";

interface DispatchParams {
	prompt: string;
	subagent_type?: string;
	model?: string;
	thinking?: string;
	max_turns?: number;
	run_in_background?: boolean;
	resume?: string;
	inherit_context?: boolean;
}

/* ------------------------------------------------------------------ *
 * The extension
 * ------------------------------------------------------------------ */

export default function subagentsExtension(pi: ExtensionAPI): void {
	let mode: HarnessMode = "default";
	let cfg = resolveSubagentConfig(process.env, process.cwd());
	let sessionEnabled = true;
	let restoreTools: string[] = [];
	let registry: AgentDefinition[] = [...BUILTIN_AGENTS];
	let diagnostics: string[] = [];
	const runs = new Map<string, AgentRun>();
	const bgQueue: Array<() => void> = [];
	let runningBackground = 0;
	let lastCtx: ExtensionContext | undefined;

	pi.events.on("audited-harness:mode", (value: unknown) => {
		if (isHarnessMode(value)) mode = value;
		else if (value && typeof value === "object" && isHarnessMode((value as { name?: string }).name)) mode = (value as { name: HarnessMode }).name;
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		runs.clear();
		runningBackground = 0;
		bgQueue.length = 0;
		restoreSessionSetting(ctx, false);
		await refreshRegistry(ctx);
		renderStatus();
	});

	pi.on("session_shutdown", () => {
		for (const run of runs.values()) {
			if (run.status === "running") run.status = "aborted";
			run.session?.abort().catch(() => {});
		}
		runs.clear();
		bgQueue.length = 0;
		runningBackground = 0;
		// Active-tool state carries across session replacement. Restore only the
		// dispatch tools removed by this setting; a disabled resumed session will
		// remove them again in its own session_start handler.
		if (!sessionEnabled && cfg.enabled) {
			pi.setActiveTools(updateSubagentTools(pi.getActiveTools(), true, restoreTools));
		}
		renderStatus();
	});

	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		restoreSessionSetting(ctx, true);
		renderStatus();
	});

	pi.on("input", () => applySessionToolSetting());

	pi.on("before_agent_start", async (event, ctx) => {
		lastCtx = ctx;
		cfg = resolveSubagentConfig(process.env, ctx.cwd);
		applySessionToolSetting();
		if (!subagentsEnabled()) return;
		const selected = event.systemPromptOptions.selectedTools;
		if (selected && !selected.includes("subagent")) return;
		await refreshRegistry(ctx);
		if (!subagentsEnabled()) return;
		const block = buildAgentsPrompt(registry, { depth: 0, maxDepth: cfg.maxDepth });
		if (!block) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});

	// Keep the active-agent footer fresh: capture the latest UI context and
	// re-render whenever a turn boundary passes (catches background completions).
	pi.on("tool_execution_end", (_event, ctx) => {
		lastCtx = ctx;
		renderStatus();
	});
	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		renderStatus();
	});

	async function refreshRegistry(ctx: ExtensionContext): Promise<void> {
		const discovered = await discoverAgents(cfg, ctx.cwd, ctx.isProjectTrusted());
		registry = discovered.agents.length ? discovered.agents : [...BUILTIN_AGENTS];
		diagnostics = discovered.diagnostics;
	}

	function audit(entry: { outcome: "approved" | "blocked"; category: string; tool: string; scope?: "once" | "session" }): void {
		const event = { ...entry, timestamp: Date.now() };
		pi.appendEntry("audited-harness:audit", event);
		pi.events.emit("audited-harness:audit", event);
	}

	/** Render the active sub-agent count into the footer status bar. */
	function renderStatus(): void {
		const ctx = lastCtx;
		if (!ctx) return;
		const active = countActiveRuns(runs.values());
		ctx.ui.setStatus(
			"audited-harness:subagents",
			active > 0 ? ctx.ui.theme.fg("muted", `agents:${active}`) : undefined,
		);
	}

	function listTypes(): string {
		return registry.map((a) => `- ${a.name}: ${a.description.split("\n")[0]}`).join("\n");
	}

	function subagentsEnabled(): boolean {
		return cfg.enabled && sessionEnabled;
	}

	function restoreSessionSetting(ctx: ExtensionContext, restoreWhenEnabled: boolean): void {
		cfg = resolveSubagentConfig(process.env, ctx.cwd);
		const previousRestoreTools = restoreTools;
		const restored = latestSubagentSessionState(ctx.sessionManager.getBranch());
		sessionEnabled = restored?.enabled ?? true;
		restoreTools = restored?.restoreTools ?? (restoreWhenEnabled ? previousRestoreTools : []);
		if (subagentsEnabled()) {
			if (restoreWhenEnabled) {
				pi.setActiveTools(updateSubagentTools(pi.getActiveTools(), true, restoreTools));
			}
		} else {
			applySessionToolSetting();
			abortActiveRuns();
		}
	}

	function applySessionToolSetting(): void {
		if (subagentsEnabled()) return;
		const active = pi.getActiveTools();
		const next = updateSubagentTools(active, false);
		if (next.length !== active.length) pi.setActiveTools(next);
	}

	function persistSessionSetting(): void {
		pi.appendEntry(SUBAGENT_SESSION_STATE_ENTRY, { enabled: sessionEnabled, restoreTools });
	}

	function abortActiveRuns(): number {
		let aborted = 0;
		for (const run of runs.values()) {
			if (run.status !== "running") continue;
			run.status = "aborted";
			run.session?.abort().catch(() => {});
			aborted++;
		}
		return aborted;
	}

	/** Resolve a model spec against the parent registry, falling back to the parent model. */
	function resolveModel(spec: string | undefined, parentCtx: ExtensionContext): NonNullable<AgentSession["model"]> | undefined {
		if (!spec) return parentCtx.model ?? undefined;
		if (spec.includes("/")) {
			const idx = spec.indexOf("/");
			const provider = spec.slice(0, idx);
			const id = spec.slice(idx + 1);
			return parentCtx.modelRegistry.find(provider, id) ?? parentCtx.model ?? undefined;
		}
		// Fuzzy alias: try the alias as an id under common providers, else inherit.
		const key = spec.toLowerCase();
		return parentCtx.modelRegistry.find("anthropic", key) ?? parentCtx.model ?? undefined;
	}

	/**
	 * Resolve a definition, create the isolated session, attach the policy gate and
	 * (when nesting is allowed) the dispatch tools, seed forked context, then kick
	 * off the run. The {@link AgentRun} is updated in place; `run.done` resolves when
	 * the run finishes. Returns false on early validation failure (run already
	 * marked errored and resolved); true once the run is underway.
	 */
	async function startRun(o: {
		params: DispatchParams;
		parentCtx: ExtensionContext;
		depth: number;
		run: AgentRun;
		resolveDone: () => void;
		background: boolean;
		push?: (text: string) => void;
	}): Promise<boolean> {
		const { params, parentCtx, depth, run, resolveDone, background, push } = o;

		if (!subagentsEnabled() || run.status === "aborted") {
			run.status = "aborted";
			resolveDone();
			return false;
		}

		const def = findAgent(registry, params.subagent_type ?? DEFAULT_TYPE) ?? findAgent(registry, DEFAULT_TYPE);
		if (!def) {
			run.status = "errored";
			run.error = `Unknown agent type '${params.subagent_type}'. Available:\n${listTypes()}`;
			resolveDone();
			return false;
		}
		run.type = def.name;

		const toolsResult = computeEffectiveTools({ def, depth, maxDepth: cfg.maxDepth, mode });
		if (toolsResult.error) {
			run.status = "errored";
			run.error = `Cannot dispatch '${def.name}': ${toolsResult.error}`;
			resolveDone();
			return false;
		}

		const modelSpec = resolveModelSpec(params.model, def.model, cfg.defaultModel);
		const model = resolveModel(modelSpec, parentCtx);
		const thinking = resolveThinking(params.thinking, def.thinking);
		const maxTurns = resolveMaxTurns(params.max_turns, def.maxTurns, cfg.maxTurns);

		let session: AgentSession;
		try {
			const gate = makeGatingExtension({
				mode,
				cwd: parentCtx.cwd,
				ui: parentCtx.ui,
				hasUI: parentCtx.hasUI,
				approvals: new Set(),
				audit,
			});
			const loader = new DefaultResourceLoader({
				cwd: parentCtx.cwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				noSkills: true,
				extensionFactories: [gate],
				appendSystemPromptOverride: (base) => [...base, def.systemPrompt].filter(Boolean),
			});
			await loader.reload();
			const created = await createAgentSession({
				cwd: parentCtx.cwd,
				agentDir: getAgentDir(),
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(parentCtx.cwd),
				...(model ? { model } : {}),
				...(thinking !== "inherit" ? { thinkingLevel: thinking } : {}),
				tools: toolsResult.tools,
				customTools: depth < cfg.maxDepth ? makeNestingTools(depth) : [],
			});
			session = created.session;
		} catch (error) {
			if ((run as AgentRun).status !== "aborted") {
				run.status = "errored";
				run.error = `Failed to start sub-agent: ${(error as Error).message}`;
			}
			resolveDone();
			return false;
		}
		run.session = session;
		// The session setting may have changed while the resource loader/session was
		// being created. Do not let that race start a run after `/agents off`.
		if (!subagentsEnabled() || (run as AgentRun).status === "aborted") {
			run.status = "aborted";
			await session.abort().catch(() => {});
			resolveDone();
			return false;
		}

		// Fork: seed the sub-agent with the parent's current conversation branch.
		if (params.inherit_context) {
			try {
				const parentMessages = parentCtx.sessionManager
					.buildContextEntries()
					.filter((e) => e.type === "message")
					.map((e) => (e as { message: unknown }).message);
				(session.agent.state as { messages: unknown[] }).messages = parentMessages;
			} catch {
				// Degrade gracefully: run with a fresh context if seeding is unavailable.
			}
		}

		let turnCount = 0;
		let lastTool: string | undefined;
		let capped = false;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "turn_end") {
				turnCount++;
				if (maxTurns > 0 && turnCount >= maxTurns && !capped) {
					capped = true;
					session.abort().catch(() => {});
				}
			} else if (event.type === "tool_execution_start") {
				lastTool = event.toolName;
			}
			push?.(`${def.name} · turn ${turnCount}${lastTool ? ` · ${lastTool}` : ""}`);
		});

		// Foreground sub-agents are cancelled when the parent run is aborted (Esc);
		// background sub-agents persist and are cleaned up on session shutdown (REQ-025).
		if (!background) {
			parentCtx.signal?.addEventListener("abort", () => session.abort().catch(() => {}), { once: true });
		}

		// Drive the run to completion in the background, updating the run in place.
		void (async () => {
			try {
				await session.prompt(params.prompt);
				const errMsg = (session.agent.state as { errorMessage?: string } | undefined)?.errorMessage;
				const text = extractFinalText(session.messages as unknown as { role: string; content: unknown }[]);
				run.finalText = text;
				// Preserve an explicit /agents off or session-shutdown abort.
				if (run.status !== "aborted") {
					if (capped) {
						run.status = "completed";
						run.finalText = `${text}\n\n(turn cap of ${maxTurns} reached)`.trim();
					} else if (!background && parentCtx.signal?.aborted) run.status = "aborted";
					else if (errMsg && !text) {
						run.status = "errored";
						run.error = errMsg;
					} else run.status = "completed";
				}
			} catch (error) {
				if (run.status !== "aborted") {
					run.status = "errored";
					run.error = (error as Error).message;
				}
			} finally {
				unsubscribe();
				resolveDone();
				renderStatus();
			}
		})();

		return true;
	}

	/** Foreground dispatch: block until the sub-agent finishes, return its result. */
	async function foregroundDispatch(params: DispatchParams, parentCtx: ExtensionContext, depth: number, push?: (text: string) => void): Promise<{ text: string; id: string }> {
		const id = generateAgentId();
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const run: AgentRun = { id, type: params.subagent_type ?? DEFAULT_TYPE, depth, background: false, status: "running", startedAt: Date.now(), done };
		runs.set(id, run);
		renderStatus();
		const started = await startRun({ params, parentCtx, depth, run, resolveDone, background: false, push });
		if (!started) throw new Error(run.error ?? "sub-agent failed to start");
		await run.done;
		if (run.status === "errored") throw new Error(run.error ?? "sub-agent error");
		if (run.status === "aborted") throw new Error("sub-agent aborted");
		return { text: run.finalText || "(sub-agent returned no final text)", id };
	}

	/** get_subagent_result body, shared by the top-level and nesting tools. */
	async function getResult(params: { agent_id: string; wait?: boolean; verbose?: boolean }): Promise<{ text: string }> {
		const run = runs.get(params.agent_id);
		if (!run) throw new Error(`No such agent: ${params.agent_id}. Known: ${[...runs.keys()].join(", ") || "(none)"}`);
		if (params.wait && run.status === "running") await run.done;
		if (run.status === "running") return { text: `Agent ${run.id} (${run.type}) is still running.` };
		if (run.status === "errored") throw new Error(`Agent ${run.type} errored: ${run.error ?? "unknown error"}`);
		if (run.status === "aborted") throw new Error(`Agent ${run.type} (${run.id}) was aborted.`);
		const body = run.finalText || "(no final text)";
		const transcript = params.verbose && run.session ? extractFullTranscript(run.session) : undefined;
		return { text: transcript ? `${body}\n\n--- transcript ---\n${transcript}` : body };
	}

	/** steer_subagent body, shared by the top-level and nesting tools. */
	async function steer(params: { agent_id: string; message: string }): Promise<{ text: string }> {
		const run = runs.get(params.agent_id);
		if (!run?.session) throw new Error(`No running agent: ${params.agent_id}`);
		if (run.status !== "running") throw new Error(`Agent ${params.agent_id} is not running (status: ${run.status}).`);
		await run.session.steer(params.message);
		return { text: `Steered ${run.type} (${run.id}).` };
	}

	/* ---------------- nesting tools (sub-agent → sub-agent) ---------------- */

	function makeNestingTools(depth: number): ToolDefinition[] {
		const childDepth = depth + 1;
		const sub: ToolDefinition = defineTool({
			name: "subagent",
			label: "Sub-agent",
			description: "Dispatch a specialized sub-agent for a complex, multi-step task.",
			parameters: SubagentParameters,
			async execute(_id, params, _signal, onUpdate, ctx) {
				if (!subagentsEnabled()) throw new Error("Sub-agents are disabled for this session.");
				const { text } = await foregroundDispatch(
					params as DispatchParams,
					ctx,
					childDepth,
					(t) => onUpdate?.({ content: [{ type: "text", text: t }], details: {} }),
				);
				return { content: [{ type: "text", text }], details: {} };
			},
		});
		const getRes: ToolDefinition = defineTool({
			name: "get_subagent_result",
			label: "Get sub-agent result",
			description: "Retrieve the status/result of a sub-agent by id.",
			parameters: GetResultParameters,
			async execute(_id, params) {
				if (!subagentsEnabled()) throw new Error("Sub-agents are disabled for this session.");
				const { text } = await getResult(params as { agent_id: string; wait?: boolean; verbose?: boolean });
				return { content: [{ type: "text", text }], details: {} };
			},
		});
		const steerTool: ToolDefinition = defineTool({
			name: "steer_subagent",
			label: "Steer sub-agent",
			description: "Send a steering message to a running sub-agent.",
			parameters: SteerParameters,
			async execute(_id, params) {
				if (!subagentsEnabled()) throw new Error("Sub-agents are disabled for this session.");
				const { text } = await steer(params as { agent_id: string; message: string });
				return { content: [{ type: "text", text }], details: {} };
			},
		});
		return [sub, getRes, steerTool];
	}

	/* ---------------- top-level tools ---------------- */

	pi.registerTool({
		name: "subagent",
		label: "Sub-agent",
		description:
			"Dispatch a specialized sub-agent for a complex, multi-step task. The sub-agent runs in its own isolated context and returns only its final result.",
		promptSnippet: "Dispatch a specialized sub-agent that runs in its own context and returns a summary",
		promptGuidelines: [
			"Use subagent to delegate self-contained tasks (exploration, research, implementation) so the work happens in a separate context and only the result returns.",
			"Pass run_in_background=true when you don't need the result immediately, then retrieve it with get_subagent_result.",
		],
		parameters: SubagentParameters,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!subagentsEnabled()) throw new Error("Sub-agents are disabled for this session.");
			const push = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: {} });

			// Resume an existing in-session sub-agent with a new prompt.
			if (params.resume) {
				const existing = runs.get(params.resume);
				if (!existing) throw new Error(`No such agent: ${params.resume}`);
				if (ONESHOT_TYPES.has(existing.type.toLowerCase())) throw new Error(`${existing.type} is one-shot and cannot be resumed.`);
				if (!existing.session) throw new Error(`Agent ${params.resume} has no active session.`);
				if (existing.status === "running") throw new Error(`Agent ${params.resume} is already running.`);
				let resolveResumeDone!: () => void;
				existing.done = new Promise<void>((resolve) => {
					resolveResumeDone = resolve;
				});
				existing.status = "running";
				existing.error = undefined;
				const abortResume = () => {
					if ((existing as AgentRun).status !== "running") return;
					existing.status = "aborted";
					existing.session?.abort().catch(() => {});
				};
				signal?.addEventListener("abort", abortResume, { once: true });
				if (signal?.aborted) abortResume();
				push(`resuming ${existing.type}`);
				renderStatus();
				try {
					if ((existing as AgentRun).status === "aborted") throw new Error("Sub-agent aborted.");
					await existing.session.prompt(params.prompt);
					if ((existing as AgentRun).status === "aborted") throw new Error("Sub-agent aborted.");
					const text = extractFinalText(existing.session.messages as unknown as { role: string; content: unknown }[]);
					existing.finalText = text;
					existing.status = "completed";
					return { content: [{ type: "text", text: text || "(sub-agent returned no final text)" }], details: { agent_id: existing.id, resumed: true } };
				} catch (error) {
					if ((existing as AgentRun).status === "aborted") throw new Error("Sub-agent aborted.");
					existing.status = "errored";
					existing.error = (error as Error).message;
					throw new Error(`Sub-agent error: ${existing.error}`);
				} finally {
					signal?.removeEventListener("abort", abortResume);
					resolveResumeDone();
					renderStatus();
				}
			}

			// Background dispatch: return an agent ID immediately, run concurrently.
			if (params.run_in_background) {
				const id = generateAgentId();
				let resolveDone!: () => void;
				const done = new Promise<void>((resolve) => {
					resolveDone = resolve;
				});
				const run: AgentRun = { id, type: params.subagent_type ?? DEFAULT_TYPE, depth: 1, background: true, status: "running", startedAt: Date.now(), done };
				runs.set(id, run);
				renderStatus();
				void (async () => {
					const release = await acquireBackground();
					try {
						const started = await startRun({ params, parentCtx: ctx, depth: 1, run, resolveDone, background: true, push });
						if (started) await run.done;
					} finally {
						await release();
					}
				})();
				return {
					content: [{ type: "text", text: `Started background sub-agent '${run.type}' (id: ${id}). Use get_subagent_result to retrieve the result.` }],
					details: { agent_id: id, background: true },
				};
			}

			// Foreground dispatch.
			const { text, id } = await foregroundDispatch(params as DispatchParams, ctx, 1, push);
			return { content: [{ type: "text", text }], details: { agent_id: id } };
		},
		renderCall(args, theme) {
			const label = args.description ? ` ${theme.fg("dim", String(args.description).slice(0, 40))}` : "";
			const tag = args.run_in_background ? " bg" : args.resume ? ` resume ${theme.fg("dim", String(args.resume))}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("muted", String(args.subagent_type ?? DEFAULT_TYPE))}${label}${tag}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text((result as { isError?: boolean }).isError ? theme.fg("error", "sub-agent error") : theme.fg("success", "✓ sub-agent done"), 0, 0);
		},
	});

	pi.registerTool({
		name: "get_subagent_result",
		label: "Get sub-agent result",
		description: "Retrieve the status and final result of a background or completed sub-agent by its agent ID.",
		parameters: GetResultParameters,
		async execute(_id, params) {
			if (!subagentsEnabled()) throw new Error("Sub-agents are disabled for this session.");
			const { text } = await getResult(params as { agent_id: string; wait?: boolean; verbose?: boolean });
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "steer_subagent",
		label: "Steer sub-agent",
		description: "Send a steering message to a running sub-agent by its agent ID.",
		parameters: SteerParameters,
		async execute(_id, params) {
			if (!subagentsEnabled()) throw new Error("Sub-agents are disabled for this session.");
			const { text } = await steer(params as { agent_id: string; message: string });
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerCommand("agents", {
		description: "Manage sub-agents for this session: list | status | on | off",
		getArgumentCompletions(prefix: string) {
			const items = ["list", "status", "on", "off"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			const sub = args.trim().toLowerCase() || "list";
			if (sub === "off") {
				if (sessionEnabled) {
					restoreTools = pi.getActiveTools().filter((tool) => (DISPATCH_TOOL_NAMES as readonly string[]).includes(tool));
				}
				sessionEnabled = false;
				applySessionToolSetting();
				persistSessionSetting();
				const aborted = abortActiveRuns();
				renderStatus();
				ctx.ui.notify(`Sub-agents disabled for this session${aborted ? `; aborted ${aborted} active run${aborted === 1 ? "" : "s"}` : ""}`, "info");
				return;
			}
			if (sub === "on") {
				if (!cfg.enabled) {
					ctx.ui.notify("Sub-agents are disabled by PI_HARNESS_DISABLE_SUBAGENTS.", "warning");
					return;
				}
				sessionEnabled = true;
				pi.setActiveTools(updateSubagentTools(pi.getActiveTools(), true, restoreTools));
				persistSessionSetting();
				await refreshRegistry(ctx);
				renderStatus();
				ctx.ui.notify("Sub-agents enabled for this session", "info");
				return;
			}
			if (sub === "status") {
				const state = !cfg.enabled ? "off (environment)" : sessionEnabled ? "on" : "off (session)";
				ctx.ui.notify(`Sub-agents: ${state}\nActive runs: ${countActiveRuns(runs.values())}`, "info");
				return;
			}
			if (sub !== "list") {
				ctx.ui.notify("Usage: /agents [list|status|on|off]", "warning");
				return;
			}
			const state = !cfg.enabled ? "off (environment)" : sessionEnabled ? "on" : "off (session)";
			const body = [
				`Sub-agents: ${state}`,
				`Registered agents (${registry.length}):`,
				...registry.map((a) => `- ${a.name} [${a.source.scope}] — ${a.description.split("\n")[0]}`),
			];
			if (diagnostics.length) body.push("", "Diagnostics:", ...diagnostics.map((d) => `- ${d}`));
			ctx.ui.notify(body.join("\n"), "info");
		},
	});

	/* ---------------- background concurrency ---------------- */

	/** Acquire a background slot, returning a release function. Queues when saturated. */
	function acquireBackground(): Promise<() => Promise<void>> {
		return new Promise((resolveRelease) => {
			const tryStart = () => {
				if (runningBackground < cfg.maxConcurrency) {
					runningBackground++;
					resolveRelease(async () => {
						runningBackground--;
						const next = bgQueue.shift();
						if (next) next();
					});
				} else {
					bgQueue.push(tryStart);
				}
			};
			tryStart();
		});
	}
}

/** Extract a compact transcript (role + text) for verbose result dumps. */
function extractFullTranscript(session: AgentSession): string {
	const msgs = session.messages as unknown as { role: string; content: unknown }[];
	const lines: string[] = [];
	for (const m of msgs) {
		const text =
			typeof m.content === "string"
				? m.content
				: Array.isArray(m.content)
					? m.content.map((c) => ((typeof c === "object" && c && (c as { text?: string }).text) || "")).join("")
					: "";
		if (text.trim()) lines.push(`[${m.role}] ${text}`);
	}
	return lines.join("\n");
}
