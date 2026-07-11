import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyCommand, classifyCustomTool, classifyFileTool, type Decision, type HarnessProfile } from "./policy-rules.js";

interface AuditEvent {
	outcome: "approved" | "blocked";
	category: string;
	tool: string;
	scope?: "once" | "session";
	timestamp: number;
}

interface ProfileState {
	name: HarnessProfile;
	planPath?: string;
}

export default function policyExtension(pi: ExtensionAPI) {
	let profile: ProfileState = { name: "develop" };
	const sessionApprovals = new Set<string>();

	pi.events.on("audited-harness:profile", (value: unknown) => {
		if (typeof value === "string" && ["inspect", "plan", "develop", "isolated"].includes(value)) {
			profile = { name: value as HarnessProfile };
			return;
		}
		const next = value as Partial<ProfileState> | undefined;
		if (next && ["inspect", "plan", "develop", "isolated"].includes(String(next.name))) {
			profile = { name: next.name as HarnessProfile, planPath: next.planPath };
		}
	});

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
			return enforce(classifyCommand(profile.name, command), "bash", command, ctx);
		}
		if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
			const path = String((event.input as { path?: unknown }).path ?? ".");
			return enforce(
				classifyFileTool(profile.name, event.toolName, ctx.cwd, path, profile.planPath),
				event.toolName,
				path,
				ctx,
			);
		}
		return enforce(classifyCustomTool(profile.name, event.toolName, ctx.cwd, event.input), event.toolName, event.toolName, ctx);
	});
}
