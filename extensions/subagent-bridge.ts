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
interface ChildSessionEvent { sessionId?: unknown; }

export interface SubagentLimits {
	maxConcurrent: number;
	maxTurns: number;
	allowModelOverride: boolean;
	allowCustomAgents: boolean;
}

export interface SubagentCallDecision {
	blockReason?: string;
	maxTurns?: number;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_TURNS = 20;
const MAX_CONFIGURED_CONCURRENT = 16;
const MAX_CONFIGURED_TURNS = 100;

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
	if (!value || !/^\d+$/.test(value)) return fallback;
	const parsed = Number(value);
	return parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

export function loadSubagentLimits(env: NodeJS.ProcessEnv = process.env): SubagentLimits {
	return {
		maxConcurrent: boundedInteger(env.PI_HARNESS_SUBAGENT_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT, MAX_CONFIGURED_CONCURRENT),
		maxTurns: boundedInteger(env.PI_HARNESS_SUBAGENT_MAX_TURNS, DEFAULT_MAX_TURNS, MAX_CONFIGURED_TURNS),
		allowModelOverride: env.PI_HARNESS_SUBAGENT_ALLOW_MODEL_OVERRIDE === "1",
		allowCustomAgents: env.PI_HARNESS_SUBAGENT_ALLOW_CUSTOM_AGENTS === "1",
	};
}

export function evaluateSubagentCall(
	mode: HarnessMode,
	input: SubagentInput,
	currentModel: { provider: string; id: string } | undefined,
	limits: SubagentLimits,
	occupiedSlots: number,
): SubagentCallDecision {
	if (mode === "inspect" || mode === "plan") {
		return { blockReason: `subagents are unavailable in ${mode} mode` };
	}
	if (mode === "permissive" || mode === "yolo") return {};
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
	const limits = loadSubagentLimits();
	let mode: HarnessMode = "default";
	let lastContext: ExtensionContext | undefined;
	const reservations = new Set<string>();
	const activeChildren = new Set<string>();

	function render(ctx = lastContext) {
		if (!ctx) return;
		const count = activeChildren.size + reservations.size;
		const text = count
			? ctx.ui.theme.fg("warning", `subagents:${count}/${limits.maxConcurrent}`)
			: ctx.ui.theme.fg("dim", `subagents:0/${limits.maxConcurrent}`);
		ctx.ui.setStatus("audited-harness:subagents", text);
	}

	pi.events.on("audited-harness:mode", (value: unknown) => {
		const name = typeof value === "string" ? value : (value as ModeState | undefined)?.name;
		if (name === "inspect" || name === "plan" || name === "default" || name === "permissive" || name === "yolo" || name === "isolated") mode = name;
	});
	pi.events.on("subagents:child:session-created", (value: unknown) => {
		const id = (value as ChildSessionEvent | undefined)?.sessionId;
		if (typeof id === "string") activeChildren.add(id);
		render();
	});
	pi.events.on("subagents:child:disposed", (value: unknown) => {
		const id = (value as ChildSessionEvent | undefined)?.sessionId;
		if (typeof id === "string") activeChildren.delete(id);
		render();
	});

	pi.on("session_start", (_event, ctx) => {
		lastContext = ctx;
		reservations.clear();
		activeChildren.clear();
		render(ctx);
	});
	pi.on("session_shutdown", () => {
		reservations.clear();
		activeChildren.clear();
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		lastContext = ctx;
		const input = event.input as SubagentInput;
		const decision = evaluateSubagentCall(mode, input, ctx.model, limits, activeChildren.size + reservations.size);
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
