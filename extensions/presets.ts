import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HARNESS_MODES, isHarnessMode, protectedWriteCategory, type HarnessMode } from "./policy-rules.js";

interface ModeState {
	name: HarnessMode;
	planPath?: string;
}

const RESTRICTED_TOOLS: Record<"inspect" | "plan", Set<string>> = {
	inspect: new Set(["read", "grep", "find", "ls", "ask_user", "web_fetch", "task"]),
	plan: new Set(["read", "grep", "find", "ls", "write", "edit", "ask_user", "web_fetch", "task"]),
};

const INSTRUCTIONS: Record<HarnessMode, string> = {
	inspect: [
		"You are in INSPECT mode. Do not modify files or execute shell commands.",
		"Explore with read-only tools, answer from evidence, and clearly distinguish findings from recommendations.",
	].join("\n"),
	plan: [
		"You are in PLAN mode. Explore safely and write only to the selected plan file.",
		"Do not implement the plan until the user approves it with /harness-plan-review.",
	].join("\n"),
	default: [
		"You are in DEFAULT mode. Make focused workspace changes and validate them with the project's native checks.",
		"Inspect before editing, keep scope proportional, review the resulting diff, and report validation evidence and residual risks.",
	].join("\n"),
	permissive: [
		"You are in PERMISSIVE mode. Harness approvals and file protections are disabled.",
		"Shell rm commands remain limited to the current project and temporary directory.",
	].join("\n"),
	yolo: [
		"You are in YOLO mode. Harness policy gates are disabled; proceed without harness approvals or blocks.",
		"Follow the user's request directly while accurately reporting actions and results.",
	].join("\n"),
	isolated: [
		"You are in ISOLATED mode inside an externally managed containment boundary.",
		"You may work autonomously within the mounted workspace, but still minimize credentials, network access, and irreversible external effects.",
	].join("\n"),
};

export default function presetsExtension(pi: ExtensionAPI) {
	let state: ModeState = { name: "default" };
	let configuredTools: string[] = [];
	let sandboxReady = false;
	let sandboxLabel = "";

	pi.registerFlag("harness-mode", {
		description: `Harness mode: ${HARNESS_MODES.join(", ")}`,
		type: "string",
	});

	pi.events.on("audited-harness:sandbox-status", (value: unknown) => {
		const status = value as { active?: unknown; provider?: unknown } | undefined;
		sandboxReady = status?.active === true;
		sandboxLabel = typeof status?.provider === "string" ? status.provider : "sandbox";
	});

	function updateStatus(ctx: ExtensionContext) {
		const color = state.name === "inspect" || state.name === "plan" || state.name === "permissive"
			? "warning"
			: state.name === "isolated" ? "success" : state.name === "yolo" ? "error" : "accent";
		const suffix = state.name === "plan" && state.planPath ? `:${relative(ctx.cwd, state.planPath)}` : "";
		ctx.ui.setStatus("audited-harness:mode", ctx.ui.theme.fg(color, `mode:${state.name}${suffix}`));
	}

	function persist() {
		pi.appendEntry("audited-harness:mode", state);
	}

	function currentConfiguredTools(): string[] {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		return configuredTools.filter((name) => available.has(name));
	}

	function enforceRestrictedToolSet() {
		if (state.name !== "inspect" && state.name !== "plan") return;
		const allowed = RESTRICTED_TOOLS[state.name];
		pi.setActiveTools(pi.getAllTools().map((tool) => tool.name).filter((name) => allowed.has(name)));
	}

	function activate(next: HarnessMode, ctx: ExtensionContext, options: { persist?: boolean; planPath?: string } = {}): boolean {
		if (next === "isolated" && !sandboxReady && process.env.PI_HARNESS_ISOLATED !== "1") {
			if (ctx.hasUI) ctx.ui.notify("Isolated mode requires an active sandbox integration or an externally established boundary", "error");
			return false;
		}
		if (state.name !== "inspect" && state.name !== "plan" && (next === "inspect" || next === "plan")) {
			configuredTools = pi.getActiveTools();
		}
		state = { name: next, planPath: next === "plan" ? options.planPath ?? state.planPath : undefined };
		if (next === "inspect" || next === "plan") enforceRestrictedToolSet();
		else pi.setActiveTools(currentConfiguredTools());
		pi.events.emit("audited-harness:mode", state);
		updateStatus(ctx);
		if (options.persist !== false) persist();
		return true;
	}

	pi.registerCommand("mode", {
		description: `Switch harness mode: ${HARNESS_MODES.join(", ")}`,
		getArgumentCompletions(prefix) {
			const items = HARNESS_MODES
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			let selected = args.trim();
			if (!selected && ctx.hasUI) selected = (await ctx.ui.select("Harness mode", [...HARNESS_MODES])) ?? "";
			if (!isHarnessMode(selected)) {
				ctx.ui.notify(`Usage: /mode ${HARNESS_MODES.join("|")}`, "warning");
				return;
			}
			if (selected === "plan") {
				ctx.ui.notify("Use /harness-plan [path] to select a protected plan file", "warning");
				return;
			}
			if (activate(selected, ctx)) ctx.ui.notify(`Harness mode changed to ${selected}`, "info");
		},
	});

	pi.registerCommand("harness-plan", {
		description: "Enter plan mode with writes restricted to one plan file",
		async handler(args, ctx) {
			const requested = args.trim() || ".pi/harness-plan.md";
			const planPath = resolve(ctx.cwd, requested.startsWith("@") ? requested.slice(1) : requested);
			const category = protectedWriteCategory(ctx.cwd, planPath);
			if (category) {
				ctx.ui.notify(`Unsafe plan path: ${category.replaceAll("-", " ")}`, "error");
				return;
			}
			if (activate("plan", ctx, { planPath })) ctx.ui.notify(`Plan mode active; only ${relative(ctx.cwd, planPath)} may be edited`, "info");
		},
	});

	pi.registerCommand("harness-plan-review", {
		description: "Review and approve the selected plan for execution",
		async handler(_args, ctx) {
			if (state.name !== "plan" || !state.planPath) {
				ctx.ui.notify("No active harness plan", "warning");
				return;
			}
			let content: string;
			try { content = await readFile(state.planPath, "utf8"); }
			catch { ctx.ui.notify(`Plan file not found: ${relative(ctx.cwd, state.planPath)}`, "error"); return; }
			if (!content.trim()) { ctx.ui.notify("Plan file is empty", "warning"); return; }
			if (!ctx.hasUI) { ctx.ui.notify("Plan approval requires interactive UI", "error"); return; }
			await ctx.ui.editor(`Review plan: ${relative(ctx.cwd, state.planPath)} (changes here are not saved)`, content.slice(0, 50_000));
			const choice = await ctx.ui.select("Plan decision", ["Approve and execute", "Keep planning", "Cancel plan"]);
			if (choice === "Approve and execute") {
				const approvedPath = state.planPath;
				activate("default", ctx);
				pi.appendEntry("audited-harness:plan-approval", { path: approvedPath, timestamp: Date.now() });
				pi.sendUserMessage(`Execute the approved plan in ${relative(ctx.cwd, approvedPath)}. Validate each completed change.`);
			} else if (choice === "Cancel plan") {
				activate("default", ctx);
				ctx.ui.notify("Plan cancelled; default mode restored", "info");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		configuredTools = pi.getActiveTools();
		pi.events.emit("audited-harness:sandbox-status-request", {
			respond: (status: unknown) => pi.events.emit("audited-harness:sandbox-status", status),
		});
		const flag = pi.getFlag("harness-mode");
		let restored: ModeState | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "audited-harness:mode") restored = entry.data as ModeState;
			if (entry.customType === "audited-harness:profile") {
				const legacy = entry.data as { name?: unknown; planPath?: string };
				if (legacy.name === "develop") restored = { name: "default", planPath: legacy.planPath };
				else if (isHarnessMode(legacy.name)) restored = { name: legacy.name, planPath: legacy.planPath };
			}
		}
		const requested = isHarnessMode(flag) ? { name: flag } : restored && isHarnessMode(restored.name) ? restored : { name: "default" as const };
		if (!activate(requested.name, ctx, { persist: false, planPath: requested.planPath })) activate("default", ctx, { persist: false });
		if (state.name === "isolated" && sandboxReady && ctx.hasUI) ctx.ui.notify(`Isolation verified by ${sandboxLabel}`, "info");
	});

	pi.on("input", () => enforceRestrictedToolSet());

	pi.on("before_agent_start", (event) => {
		enforceRestrictedToolSet();
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Active harness mode\n${INSTRUCTIONS[state.name]}${state.planPath ? `\nSelected plan file: ${state.planPath}` : ""}`,
		};
	});
}
