import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HarnessMode } from "./policy-rules.js";

interface ModeState { name: HarnessMode; }
interface SubagentInput {
	subagent_type?: unknown;
	model?: unknown;
	max_turns?: unknown;
	run_in_background?: unknown;
	resume?: unknown;
}
interface ChildSessionEvent {
	sessionId?: unknown;
	parentSessionId?: unknown;
}

export interface SubagentLimits {
	maxConcurrent: number;
	maxTurns: number;
	/** Maximum depth of nested subagent delegation (1 = no nesting). */
	maxDepth: number;
	allowModelOverride: boolean;
	allowCustomAgents: boolean;
}

export interface SubagentCallDecision {
	blockReason?: string;
	maxTurns?: number;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_DEPTH = 1;
const MAX_CONFIGURED_CONCURRENT = 16;
const MAX_CONFIGURED_TURNS = 100;
const MAX_CONFIGURED_DEPTH = 5;

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
	if (!value || !/^\d+$/.test(value)) return fallback;
	const parsed = Number(value);
	return parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

export function loadSubagentLimits(env: NodeJS.ProcessEnv = process.env): SubagentLimits {
	return {
		maxConcurrent: boundedInteger(env.PI_HARNESS_SUBAGENT_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT, MAX_CONFIGURED_CONCURRENT),
		maxTurns: boundedInteger(env.PI_HARNESS_SUBAGENT_MAX_TURNS, DEFAULT_MAX_TURNS, MAX_CONFIGURED_TURNS),
		maxDepth: boundedInteger(env.PI_HARNESS_SUBAGENT_MAX_DEPTH, DEFAULT_MAX_DEPTH, MAX_CONFIGURED_DEPTH),
		allowModelOverride: env.PI_HARNESS_SUBAGENT_ALLOW_MODEL_OVERRIDE === "1",
		allowCustomAgents: env.PI_HARNESS_SUBAGENT_ALLOW_CUSTOM_AGENTS === "1",
	};
}

/**
 * Decide whether a `subagent` call may proceed under harness policy.
 *
 * `currentDepth` is the depth of the session *issuing* the call (root parent = 0,
 * a direct child = 1, …). The spawned child would sit at `currentDepth + 1`, so a
 * session at depth >= `limits.maxDepth` is blocked from delegating further.
 * Defaults to 0 (the root) so callers that omit it behave as the top-level parent.
 */
export function evaluateSubagentCall(
	mode: HarnessMode,
	input: SubagentInput,
	currentModel: { provider: string; id: string } | undefined,
	limits: SubagentLimits,
	occupiedSlots: number,
	currentDepth: number = 0,
): SubagentCallDecision {
	if (mode === "inspect" || mode === "plan") {
		return { blockReason: `subagents are unavailable in ${mode} mode` };
	}
	if (mode === "permissive" || mode === "yolo") return {};
	if (currentDepth >= limits.maxDepth) {
		return { blockReason: `nested subagents exceed the configured depth limit (${limits.maxDepth}); this session is already at depth ${currentDepth}` };
	}
	if (occupiedSlots >= limits.maxConcurrent) {
		return { blockReason: `subagent concurrency limit reached (${limits.maxConcurrent})` };
	}
	if (!limits.allowCustomAgents && typeof input.subagent_type === "string") {
		const type = input.subagent_type.toLowerCase();
		if (type !== "explore" && type !== "plan" && type !== "general-purpose") {
			return { blockReason: `custom agent type ${input.subagent_type} is disabled by default` };
		}
	}
	if (!limits.allowModelOverride && typeof input.model === "string" && input.model.trim()) {
		const selected = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;
		if (!selected || input.model !== selected) {
			return { blockReason: `subagent model overrides are disabled; omit model or use ${selected ?? "the parent model"}` };
		}
	}
	const requestedTurns = typeof input.max_turns === "number" && Number.isFinite(input.max_turns)
		? Math.floor(input.max_turns)
		: limits.maxTurns;
	return { maxTurns: Math.max(1, Math.min(requestedTurns, limits.maxTurns)) };
}

export default function subagentBridgeExtension(pi: ExtensionAPI) {
	// Seeded with defaults so an early `render()` is safe, but re-read on every
	// `session_start`. The `environment` extension applies `.pi/settings.json`
	// overrides to `process.env` inside its own `session_start` handler, which
	// (being registered earlier) runs to completion before this one. Reading here
	// therefore picks up the override; reading at factory time would not, since
	// extension binding happens before any `session_start` is emitted.
	let limits = loadSubagentLimits();
	let mode: HarnessMode = "default";
	let lastContext: ExtensionContext | undefined;
	const reservations = new Set<string>();
	const activeChildren = new Set<string>();
	// sessionId → parentSessionId, reconstructed from the engine's child-lifecycle
	// events so the bridge can compute the depth of the session invoking a
	// `subagent` call. The root parent has no entry (depth 0); each child maps to
	// its parent, letting `depthOf` walk the chain.
	const parentOf = new Map<string, string | undefined>();

	function depthOf(sessionId: string | undefined): number {
		if (!sessionId) return 0;
		let depth = 0;
		let current: string | undefined = parentOf.get(sessionId);
		let guard = 0;
		while (typeof current === "string" && guard++ < 64) {
			depth++;
			current = parentOf.get(current);
		}
		return depth;
	}

	function render(ctx = lastContext) {
		if (!ctx) return;
		const count = activeChildren.size + reservations.size;
		const depthTag = limits.maxDepth > 1 ? ` ·depth≤${limits.maxDepth}` : "";
		const base = `subagents:${count}/${limits.maxConcurrent}${depthTag}`;
		const text = count ? ctx.ui.theme.fg("warning", base) : ctx.ui.theme.fg("dim", base);
		ctx.ui.setStatus("audited-harness:subagents", text);
	}

	pi.events.on("audited-harness:mode", (value: unknown) => {
		const name = typeof value === "string" ? value : (value as ModeState | undefined)?.name;
		if (name === "inspect" || name === "plan" || name === "default" || name === "permissive" || name === "yolo" || name === "isolated") mode = name;
	});
	pi.events.on("subagents:child:session-created", (value: unknown) => {
		const event = value as ChildSessionEvent | undefined;
		const id = event?.sessionId;
		if (typeof id === "string") {
			activeChildren.add(id);
			parentOf.set(id, typeof event?.parentSessionId === "string" ? event.parentSessionId : undefined);
		}
		render();
	});
	pi.events.on("subagents:child:disposed", (value: unknown) => {
		const id = (value as ChildSessionEvent | undefined)?.sessionId;
		if (typeof id === "string") {
			activeChildren.delete(id);
			parentOf.delete(id);
		}
		render();
	});

	pi.on("session_start", (_event, ctx) => {
		limits = loadSubagentLimits();
		lastContext = ctx;
		reservations.clear();
		activeChildren.clear();
		parentOf.clear();
		render(ctx);
	});
	pi.on("session_shutdown", () => {
		reservations.clear();
		activeChildren.clear();
		parentOf.clear();
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		lastContext = ctx;
		const input = event.input as SubagentInput;
		const currentDepth = depthOf(ctx.sessionManager?.getSessionId());
		const decision = evaluateSubagentCall(mode, input, ctx.model, limits, activeChildren.size + reservations.size, currentDepth);
		if (decision.blockReason) return { block: true, reason: `Subagent policy: ${decision.blockReason}` };
		if (typeof decision.maxTurns === "number") input.max_turns = decision.maxTurns;
		reservations.add(event.toolCallId);
		render(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		reservations.delete(event.toolCallId);
		render(ctx);
	});
}
