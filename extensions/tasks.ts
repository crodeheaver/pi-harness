import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TaskStatus = "pending" | "in_progress" | "completed";
interface Task { id: number; subject: string; status: TaskStatus; }
interface TaskDetails { action: string; tasks: Task[]; nextId: number; error?: string; }

const Parameters = Type.Object({
	action: StringEnum(["create", "update", "list", "delete", "clear"] as const),
	id: Type.Optional(Type.Integer({ minimum: 1, description: "Task id for update or delete" })),
	subject: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: "Task subject for create or update" })),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
});

export default function tasksExtension(pi: ExtensionAPI) {
	let tasks: Task[] = [];
	let nextId = 1;

	function snapshot(action: string, error?: string): TaskDetails {
		return { action, tasks: tasks.map((task) => ({ ...task })), nextId, error };
	}

	function restore(ctx: ExtensionContext) {
		tasks = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task") continue;
			const details = entry.message.details as TaskDetails | undefined;
			if (details) { tasks = details.tasks.map((task) => ({ ...task })); nextId = details.nextId; }
		}
		render(ctx);
	}

	function render(ctx: ExtensionContext) {
		const visible = tasks.filter((task) => task.status !== "completed");
		if (!visible.length) { ctx.ui.setWidget("audited-harness:tasks", undefined); return; }
		const lines = visible.slice(0, 8).map((task) => {
			const marker = task.status === "in_progress" ? ctx.ui.theme.fg("accent", "◉") : ctx.ui.theme.fg("dim", "○");
			return `${marker} ${ctx.ui.theme.fg("muted", `#${task.id}`)} ${task.subject}`;
		});
		if (visible.length > 8) lines.push(ctx.ui.theme.fg("dim", `… ${visible.length - 8} more`));
		ctx.ui.setWidget("audited-harness:tasks", lines);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.registerTool({
		name: "task",
		label: "Task",
		description: "Maintain a small session-branch task ledger for multi-step work. Avoid it for trivial one-step requests.",
		promptSnippet: "Create, update, list, delete, or clear session tasks",
		promptGuidelines: ["Use task only for genuinely multi-step work; keep statuses current and complete tasks only after validation."],
		parameters: Parameters,
		async execute(_id, params, _signal, _update, ctx) {
			let message = "";
			let error: string | undefined;
			if (params.action === "create") {
				if (!params.subject?.trim()) error = "subject is required for create";
				else {
					const task: Task = { id: nextId++, subject: params.subject.trim(), status: params.status ?? "pending" };
					tasks.push(task);
					message = `Created task #${task.id}: ${task.subject}`;
				}
			} else if (params.action === "update") {
				const task = tasks.find((item) => item.id === params.id);
				if (!task) error = `task #${params.id ?? "?"} not found`;
				else {
					if (params.subject?.trim()) task.subject = params.subject.trim();
					if (params.status) task.status = params.status;
					message = `Updated task #${task.id}: ${task.status}`;
				}
			} else if (params.action === "delete") {
				const index = tasks.findIndex((item) => item.id === params.id);
				if (index < 0) error = `task #${params.id ?? "?"} not found`;
				else { const [removed] = tasks.splice(index, 1); message = `Deleted task #${removed?.id}`; }
			} else if (params.action === "clear") {
				const count = tasks.length; tasks = []; nextId = 1; message = `Cleared ${count} tasks`;
			} else {
				message = tasks.length ? tasks.map((task) => `[${task.status}] #${task.id} ${task.subject}`).join("\n") : "No tasks";
			}
			render(ctx);
			const details = snapshot(params.action, error);
			return { content: [{ type: "text", text: error ? `Error: ${error}` : message }], details };
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("task "))}${theme.fg("muted", args.action)}${args.id ? ` #${args.id}` : ""}${args.subject ? ` ${theme.fg("dim", args.subject)}` : ""}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as TaskDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", details.error), 0, 0);
			const pending = details?.tasks.filter((task) => task.status !== "completed").length ?? 0;
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${pending} active task${pending === 1 ? "" : "s"}`), 0, 0);
		},
	});

	pi.registerCommand("tasks", {
		description: "Show the current session task ledger",
		handler: async (_args, ctx) => {
			const text = tasks.length ? tasks.map((task) => `[${task.status}] #${task.id} ${task.subject}`).join("\n") : "No tasks";
			ctx.ui.notify(text, "info");
		},
	});
}
