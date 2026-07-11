import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyCommand, classifyCustomTool, classifyFileTool, isHarnessMode, type Decision, type HarnessMode } from "./policy-rules.js";

interface AuditEvent {
	outcome: "approved" | "blocked";
	category: string;
	tool: string;
	scope?: "once" | "session";
	timestamp: number;
}

interface ModeState {
	name: HarnessMode;
	planPath?: string;
}

export default function policyExtension(pi: ExtensionAPI) {
	let mode: ModeState = { name: "default" };
	const sessionApprovals = new Set<string>();

	function updateMode(value: unknown) {
		if (isHarnessMode(value)) {
			mode = { name: value };
			return;
		}
		const next = value as Partial<ModeState> | undefined;
		if (next && isHarnessMode(next.name)) mode = { name: next.name, planPath: next.planPath };
	}

	pi.events.on("audited-harness:mode", updateMode);

	function audit(outcome: AuditEvent["outcome"], category: string, tool: string, scope?: AuditEvent["scope"]) {
		const event: AuditEvent = { outcome, category, tool, scope, timestamp: Date.now() };
		pi.appendEntry("audited-harness:audit", event);
		pi.events.emit("audited-harness:audit", event);
	}

	function approvalKey(category: string, tool: string): string {
		return ["third-party-tool", "custom-tool-effect", "mcp-operation", "subagent-operation"].includes(category)
			? `${category}:${tool}`
			: category;
	}

	async function enforce(decision: Decision, tool: string, summary: string, ctx: ExtensionContext) {
		if (decision.action === "allow") return undefined;
		if (decision.action === "block") {
			audit("blocked", decision.category, tool);
			if (ctx.hasUI) ctx.ui.notify(`Blocked: ${decision.reason}`, "warning");
			return { block: true as const, reason: `Safety policy: ${decision.reason}` };
		}
		const key = approvalKey(decision.category, tool);
		if (sessionApprovals.has(key)) {
			audit("approved", decision.category, tool, "session");
			return undefined;
		}
		if (!ctx.hasUI) {
			audit("blocked", decision.category, tool);
			return { block: true as const, reason: `Approval required but no interactive UI is available: ${decision.reason}` };
		}
		const choice = await ctx.ui.select(
			`Approve ${decision.category.replaceAll("-", " ")}?`,
			[
				`Allow once — ${summary}`,
				"Allow this tool/category for the session",
				"Deny",
			],
		);
		if (choice?.startsWith("Allow this tool/category")) {
			sessionApprovals.add(key);
			audit("approved", decision.category, tool, "session");
			return undefined;
		}
		if (choice?.startsWith("Allow once")) {
			audit("approved", decision.category, tool, "once");
			return undefined;
		}
		audit("blocked", decision.category, tool);
		return { block: true as const, reason: `User declined: ${decision.reason}` };
	}

	pi.on("session_start", () => sessionApprovals.clear());

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			return enforce(classifyCommand(mode.name, command, ctx.cwd), "bash", command, ctx);
		}
		if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
			const path = String((event.input as { path?: unknown }).path ?? ".");
			return enforce(
				classifyFileTool(mode.name, event.toolName, ctx.cwd, path, mode.planPath),
				event.toolName,
				path,
				ctx,
			);
		}
		return enforce(classifyCustomTool(mode.name, event.toolName, ctx.cwd, event.input), event.toolName, event.toolName, ctx);
	});
}
