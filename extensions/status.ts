import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface AuditEvent {
	outcome: "approved" | "blocked";
}

export default function statusExtension(pi: ExtensionAPI) {
	let approved = 0;
	let blocked = 0;

	function render(ctx: ExtensionContext) {
		const theme = ctx.ui.theme;
		const parts = [];
		if (approved) parts.push(theme.fg("warning", `${approved} approved`));
		if (blocked) parts.push(theme.fg("error", `${blocked} blocked`));
		ctx.ui.setStatus("audited-harness:safety", parts.join(theme.fg("dim", " · ")));
	}

	pi.events.on("audited-harness:audit", (value: unknown) => {
		const event = value as AuditEvent;
		if (event?.outcome === "approved") approved++;
		if (event?.outcome === "blocked") blocked++;
	});

	pi.on("session_start", (_event, ctx) => {
		approved = 0;
		blocked = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "audited-harness:audit") continue;
			const event = entry.data as AuditEvent | undefined;
			if (event?.outcome === "approved") approved++;
			if (event?.outcome === "blocked") blocked++;
		}
		render(ctx);
	});

	pi.on("tool_execution_end", (_event, ctx) => render(ctx));
	pi.on("agent_settled", (_event, ctx) => {
		render(ctx);
		if (process.env.PI_HARNESS_NOTIFY === "1" && ctx.mode === "tui") {
			process.stdout.write("\u001b]777;notify;Pi;Ready for input\u0007");
		}
	});
}
