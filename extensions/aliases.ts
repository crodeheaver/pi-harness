import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Quality-of-life aliases for built-in Pi commands.
 *
 * `/clear` — start a fresh session, exactly like the built-in `/new`
 * (familiar to Claude Code users). It delegates to `ctx.newSession()`,
 * the same runtime path `/new` uses, and only reports feedback through
 * the replacement-session context, per the session-replacement lifecycle
 * rules (the old command `ctx` is stale once the switch completes).
 */
export default function aliasesExtension(pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		async handler(_args, ctx) {
			const result = await ctx.newSession({
				withSession: async (newCtx) => {
					if (newCtx.hasUI) newCtx.ui.notify("New session started", "info");
				},
			});
			// On cancellation nothing switched, so the original ctx is still valid.
			if (result.cancelled && ctx.hasUI) ctx.ui.notify("New session cancelled", "warning");
		},
	});
}
