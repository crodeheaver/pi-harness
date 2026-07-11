import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "anthropic";
const STRICT_ENV = "PI_HARNESS_ANTHROPIC_SUBSCRIPTION_ONLY";

export type AnthropicAuthMode = "not-anthropic" | "subscription" | "api-key-override" | "not-subscription";

export function anthropicAuthMode(
	provider: string | undefined,
	storedOAuth: boolean,
	argv: readonly string[] = process.argv,
): AnthropicAuthMode {
	if (provider !== PROVIDER) return "not-anthropic";
	if (argv.some((arg) => arg === "--api-key" || arg.startsWith("--api-key="))) return "api-key-override";
	return storedOAuth ? "subscription" : "not-subscription";
}

function currentMode(ctx: ExtensionContext): AnthropicAuthMode {
	return anthropicAuthMode(ctx.model?.provider, !!ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model));
}

function renderStatus(ctx: ExtensionContext): void {
	const mode = currentMode(ctx);
	if (mode === "not-anthropic") {
		ctx.ui.setStatus("audited-harness:anthropic-auth", undefined);
		return;
	}
	const subscription = mode === "subscription";
	ctx.ui.setStatus(
		"audited-harness:anthropic-auth",
		ctx.ui.theme.fg(subscription ? "success" : "warning", subscription ? "anthropic:subscription" : "anthropic:not-subscription"),
	);
}

export default function anthropicSubscriptionExtension(pi: ExtensionAPI) {
	pi.registerCommand("anthropic-subscription-status", {
		description: "Show whether the selected Anthropic model uses stored Pro/Max OAuth",
		handler: async (_args, ctx) => {
			const mode = currentMode(ctx);
			const messages: Record<AnthropicAuthMode, string> = {
				"not-anthropic": "The selected model is not an Anthropic model.",
				subscription: "Anthropic is using stored OAuth intended for Pro/Max subscription usage.",
				"api-key-override": "Anthropic OAuth is overridden by the --api-key CLI option; this may incur metered API charges.",
				"not-subscription": "Anthropic is not using stored OAuth. Run /login and select Anthropic (Claude Pro/Max).",
			};
			ctx.ui.notify(messages[mode], mode === "subscription" || mode === "not-anthropic" ? "info" : "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => renderStatus(ctx));
	pi.on("model_select", (_event, ctx) => renderStatus(ctx));

	pi.on("input", (_event, ctx) => {
		if (process.env[STRICT_ENV] !== "1") return;
		const mode = currentMode(ctx);
		if (mode === "not-anthropic" || mode === "subscription") return;
		ctx.ui.notify(
			mode === "api-key-override"
				? "Anthropic request blocked: --api-key overrides subscription OAuth. Restart without --api-key."
				: "Anthropic request blocked: subscription-only mode requires /login → Anthropic (Claude Pro/Max).",
			"error",
		);
		return { action: "handled" as const };
	});
}
