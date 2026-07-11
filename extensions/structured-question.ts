import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const Parameters = Type.Object({
	question: Type.String({ description: "A concise question that requires the user's decision" }),
	options: Type.Array(
		Type.Object({
			label: Type.String({ description: "Short answer label" }),
			description: Type.Optional(Type.String({ description: "Consequence or additional context" })),
		}),
		{ minItems: 1, maxItems: 8, description: "Distinct, actionable choices" },
	),
	allowCustomAnswer: Type.Optional(Type.Boolean({ description: "Allow a free-form answer; defaults to true" })),
});

interface Details {
	question: string;
	answer?: string;
	cancelled: boolean;
	custom: boolean;
}

export default function structuredQuestionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: "Ask one structured question when a material ambiguity cannot be resolved from available context. Do not use for routine confirmations or status updates.",
		promptSnippet: "Ask the user one structured question when a material decision is required",
		promptGuidelines: [
			"Use ask_user only when a material ambiguity cannot be resolved from repository context; otherwise make a reasonable reversible choice.",
		],
		parameters: Parameters,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("ask_user requires interactive TUI or RPC UI support");
			const customLabel = "Other — type a custom answer";
			const choices = params.options.map((option) =>
				option.description ? `${option.label} — ${option.description}` : option.label,
			);
			if (params.allowCustomAnswer !== false) choices.push(customLabel);
			const selected = await ctx.ui.select(params.question, choices);
			if (!selected) {
				return {
					content: [{ type: "text", text: "The user cancelled the question without answering." }],
					details: { question: params.question, cancelled: true, custom: false } satisfies Details,
				};
			}
			let answer = selected;
			let custom = false;
			if (selected === customLabel) {
				const entered = await ctx.ui.input("Your answer:");
				if (!entered?.trim()) {
					return {
						content: [{ type: "text", text: "The user cancelled the question without answering." }],
						details: { question: params.question, cancelled: true, custom: true } satisfies Details,
					};
				}
				answer = entered.trim();
				custom = true;
			} else {
				const index = choices.indexOf(selected);
				answer = params.options[index]?.label ?? selected;
			}
			return {
				content: [{ type: "text", text: `User answered: ${answer}` }],
				details: { question: params.question, answer, cancelled: false, custom } satisfies Details,
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("ask_user "))}${theme.fg("muted", args.question)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as Details | undefined;
			if (!details || details.cancelled) return new Text(theme.fg("warning", "No answer"), 0, 0);
			return new Text(`${theme.fg("success", "✓ ")}${theme.fg("accent", details.answer ?? "")}`, 0, 0);
		},
	});
}
