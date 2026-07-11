import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HarnessProfile } from "./policy-rules.js";
import { protectedWriteCategory } from "./policy-rules.js";

interface ProfileState {
	name: HarnessProfile;
	planPath?: string;
}

const RESTRICTED_TOOLS: Record<"inspect" | "plan", Set<string>> = {
	inspect: new Set(["read", "grep", "find", "ls", "ask_user", "web_fetch", "task"]),
	plan: new Set(["read", "grep", "find", "ls", "write", "edit", "ask_user", "web_fetch", "task"]),
};

const INSTRUCTIONS: Record<HarnessProfile, string> = {
	inspect: [
		"You are in INSPECT profile. Do not modify files or execute shell commands.",
		"Explore with read-only tools, answer from evidence, and clearly distinguish findings from recommendations.",
	].join("\n"),
	plan: [
		"You are in PLAN profile. Explore safely and write only to the selected plan file.",
		"Do not implement the plan until the user approves it with /harness-plan-review.",
	].join("\n"),
	develop: [
		"You are in DEVELOP profile. Make focused workspace changes and validate them with the project's native checks.",
		"Inspect before editing, keep scope proportional, review the resulting diff, and report validation evidence and residual risks.",
	].join("\n"),
	isolated: [
		"You are in ISOLATED profile inside an externally managed containment boundary.",
		"You may work autonomously within the mounted workspace, but still minimize credentials, network access, and irreversible external effects.",
	].join("\n"),
};

function isProfile(value: unknown): value is HarnessProfile {
	return value === "inspect" || value === "plan" || value === "develop" || value === "isolated";
}

export default function presetsExtension(pi: ExtensionAPI) {
	let state: ProfileState = { name: "develop" };
	let developTools: string[] = [];
	let sandboxReady = false;
	let sandboxLabel = "";

	pi.registerFlag("harness-profile", {
		description: "Execution profile: inspect, plan, develop, or isolated",
		type: "string",
	});

	pi.events.on("audited-harness:sandbox-status", (value: unknown) => {
		const status = value as { active?: unknown; provider?: unknown } | undefined;
		sandboxReady = status?.active === true;
		sandboxLabel = typeof status?.provider === "string" ? status.provider : "sandbox";
	});

	function updateStatus(ctx: ExtensionContext) {
		const color = state.name === "inspect" || state.name === "plan" ? "warning" : state.name === "isolated" ? "success" : "accent";
		const suffix = state.name === "plan" && state.planPath ? `:${relative(ctx.cwd, state.planPath)}` : "";
		ctx.ui.setStatus("audited-harness:profile", ctx.ui.theme.fg(color, `profile:${state.name}${suffix}`));
	}

	function persist() {
		pi.appendEntry("audited-harness:profile", state);
	}

	function currentConfiguredTools(): string[] {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		return developTools.filter((name) => available.has(name));
	}

	function enforceRestrictedToolSet() {
		if (state.name !== "inspect" && state.name !== "plan") return;
		const allowed = RESTRICTED_TOOLS[state.name];
		pi.setActiveTools(pi.getAllTools().map((tool) => tool.name).filter((name) => allowed.has(name)));
	}

	function activate(next: HarnessProfile, ctx: ExtensionContext, options: { persist?: boolean; planPath?: string } = {}): boolean {
		if (next === "isolated" && !sandboxReady && process.env.PI_HARNESS_ISOLATED !== "1") {
			if (ctx.hasUI) ctx.ui.notify("Isolated profile requires an active sandbox integration or an externally established boundary", "error");
			return false;
		}
		if ((state.name === "develop" || state.name === "isolated") && (next === "inspect" || next === "plan")) {
			developTools = pi.getActiveTools();
		}
		state = { name: next, planPath: next === "plan" ? options.planPath ?? state.planPath : undefined };
		if (next === "inspect" || next === "plan") {
			enforceRestrictedToolSet();
		} else {
			pi.setActiveTools(currentConfiguredTools());
		}
		pi.events.emit("audited-harness:profile", state);
		updateStatus(ctx);
		if (options.persist !== false) persist();
		return true;
	}

	pi.registerCommand("harness-profile", {
		description: "Switch execution profile: inspect, plan, develop, or isolated",
		getArgumentCompletions(prefix) {
			const items = (["inspect", "plan", "develop", "isolated"] as HarnessProfile[])
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			let selected = args.trim();
			if (!selected && ctx.hasUI) selected = (await ctx.ui.select("Execution profile", ["inspect", "plan", "develop", "isolated"])) ?? "";
			if (!isProfile(selected)) {
				ctx.ui.notify("Usage: /harness-profile inspect|plan|develop|isolated", "warning");
				return;
			}
			if (selected === "plan") {
				ctx.ui.notify("Use /harness-plan [path] to select a protected plan file", "warning");
				return;
			}
			if (activate(selected, ctx)) ctx.ui.notify(`Harness profile changed to ${selected}`, "info");
		},
	});

	pi.registerCommand("harness-plan", {
		description: "Enter plan profile with writes restricted to one plan file",
		async handler(args, ctx) {
			const requested = args.trim() || ".pi/harness-plan.md";
			const planPath = resolve(ctx.cwd, requested.startsWith("@") ? requested.slice(1) : requested);
			const category = protectedWriteCategory(ctx.cwd, planPath);
			if (category) {
				ctx.ui.notify(`Unsafe plan path: ${category.replaceAll("-", " ")}`, "error");
				return;
			}
			if (activate("plan", ctx, { planPath })) ctx.ui.notify(`Plan profile active; only ${relative(ctx.cwd, planPath)} may be edited`, "info");
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
				activate("develop", ctx);
				pi.appendEntry("audited-harness:plan-approval", { path: approvedPath, timestamp: Date.now() });
				pi.sendUserMessage(`Execute the approved plan in ${relative(ctx.cwd, approvedPath)}. Validate each completed change.`);
			} else if (choice === "Cancel plan") {
				activate("develop", ctx);
				ctx.ui.notify("Plan cancelled; develop profile restored", "info");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		developTools = pi.getActiveTools();
		pi.events.emit("audited-harness:sandbox-status-request", {
			respond: (status: unknown) => pi.events.emit("audited-harness:sandbox-status", status),
		});
		const flag = pi.getFlag("harness-profile");
		let restored: ProfileState | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "audited-harness:profile") restored = entry.data as ProfileState;
		}
		const requested = isProfile(flag) ? { name: flag } : restored && isProfile(restored.name) ? restored : { name: "develop" as const };
		if (!activate(requested.name, ctx, { persist: false, planPath: requested.planPath })) activate("develop", ctx, { persist: false });
		if (state.name === "isolated" && sandboxReady && ctx.hasUI) ctx.ui.notify(`Isolation verified by ${sandboxLabel}`, "info");
	});

	pi.on("input", () => enforceRestrictedToolSet());

	pi.on("before_agent_start", (event) => {
		enforceRestrictedToolSet();
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Active harness profile\n${INSTRUCTIONS[state.name]}${state.planPath ? `\nSelected plan file: ${state.planPath}` : ""}`,
		};
	});
}
