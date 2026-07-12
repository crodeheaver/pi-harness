import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateSubagentCall, loadSubagentLimits } from "../extensions/subagent-bridge.ts";

const defaults = { maxConcurrent: 2, maxTurns: 20, maxDepth: 1, allowModelOverride: false, allowCustomAgents: false };
const model = { provider: "anthropic", id: "claude-sonnet-4-5" };

describe("subagent bridge limits", () => {
	it("uses conservative defaults and validates environment overrides", () => {
		assert.deepEqual(loadSubagentLimits({}), defaults);
		assert.deepEqual(loadSubagentLimits({
			PI_HARNESS_SUBAGENT_MAX_CONCURRENT: "3",
			PI_HARNESS_SUBAGENT_MAX_TURNS: "40",
			PI_HARNESS_SUBAGENT_ALLOW_MODEL_OVERRIDE: "1",
			PI_HARNESS_SUBAGENT_ALLOW_CUSTOM_AGENTS: "1",
		}), { maxConcurrent: 3, maxTurns: 40, maxDepth: 1, allowModelOverride: true, allowCustomAgents: true });
		assert.equal(loadSubagentLimits({ PI_HARNESS_SUBAGENT_MAX_CONCURRENT: "999" }).maxConcurrent, 2);
		assert.equal(loadSubagentLimits({ PI_HARNESS_SUBAGENT_MAX_DEPTH: "3" }).maxDepth, 3);
		assert.equal(loadSubagentLimits({ PI_HARNESS_SUBAGENT_MAX_DEPTH: "99" }).maxDepth, 1);
	});

	it("blocks subagents in restricted modes", () => {
		assert.match(evaluateSubagentCall("inspect", {}, model, defaults, 0).blockReason ?? "", /inspect/);
		assert.match(evaluateSubagentCall("plan", {}, model, defaults, 0).blockReason ?? "", /plan/);
	});

	it("enforces concurrency and turn ceilings in default mode", () => {
		assert.match(evaluateSubagentCall("default", {}, model, defaults, 2).blockReason ?? "", /concurrency/);
		assert.equal(evaluateSubagentCall("default", {}, model, defaults, 0).maxTurns, 20);
		assert.equal(evaluateSubagentCall("default", { max_turns: 80 }, model, defaults, 0).maxTurns, 20);
		assert.equal(evaluateSubagentCall("default", { max_turns: 8 }, model, defaults, 0).maxTurns, 8);
	});

	it("allows only the three reviewed built-in roles by default", () => {
		assert.equal(evaluateSubagentCall("default", { subagent_type: "Explore" }, model, defaults, 0).blockReason, undefined);
		assert.equal(evaluateSubagentCall("default", { subagent_type: "reviewer" }, model, defaults, 0).blockReason !== undefined, true);
		assert.equal(evaluateSubagentCall("default", { subagent_type: "reviewer" }, model, { ...defaults, allowCustomAgents: true }, 0).blockReason, undefined);
	});

	it("bypasses bridge restrictions in permissive and yolo modes", () => {
		assert.deepEqual(evaluateSubagentCall("permissive", { subagent_type: "reviewer" }, model, defaults, 99), {});
		assert.deepEqual(evaluateSubagentCall("yolo", { model: "other/model" }, model, defaults, 99), {});
	});

	it("caps nesting depth unless the limit is raised", () => {
		// Default maxDepth = 1: the root (depth 0) may spawn a depth-1 child, but a
		// child (depth >= 1) may not delegate further. This preserves today's behavior.
		assert.equal(evaluateSubagentCall("default", {}, model, defaults, 0, 0).blockReason, undefined);
		assert.match(evaluateSubagentCall("default", {}, model, defaults, 0, 1).blockReason ?? "", /depth/);
		// Raising the limit admits one extra level of delegation, then stops.
		const deeper = { ...defaults, maxDepth: 2 };
		assert.equal(evaluateSubagentCall("default", {}, model, deeper, 0, 1).blockReason, undefined);
		assert.match(evaluateSubagentCall("default", {}, model, deeper, 0, 2).blockReason ?? "", /depth/);
		// Permissive/yolo bypass the depth guard like every other subagent limit.
		assert.equal(evaluateSubagentCall("permissive", {}, model, defaults, 0, 9).blockReason, undefined);
		assert.equal(evaluateSubagentCall("yolo", {}, model, defaults, 0, 9).blockReason, undefined);
	});

	it("rejects model changes unless explicitly enabled", () => {
		assert.equal(evaluateSubagentCall("default", { model: "openai/gpt-5" }, model, defaults, 0).blockReason !== undefined, true);
		assert.equal(evaluateSubagentCall("default", { model: "anthropic/claude-sonnet-4-5" }, model, defaults, 0).blockReason, undefined);
		assert.equal(evaluateSubagentCall("default", { model: "openai/gpt-5" }, model, { ...defaults, allowModelOverride: true }, 0).blockReason, undefined);
	});
});
