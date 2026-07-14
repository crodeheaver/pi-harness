import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import subagentsExtension, {
	BUILTIN_AGENTS,
	DISPATCH_TOOL_NAMES,
	ONESHOT_TYPES,
	SUBAGENT_DECISION_GUIDANCE,
	countActiveRuns,
	buildAgentsPrompt,
	collectAgentFiles,
	computeEffectiveTools,
	discoverAgents,
	extractFinalText,
	findAgent,
	findRepoRoot,
	generateAgentId,
	latestSubagentSessionState,
	mergeAgents,
	parseAgentFile,
	resolveMaxTurns,
	resolveModelSpec,
	resolveSubagentConfig,
	resolveThinking,
	updateSubagentTools,
} from "../extensions/subagents.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-harness-subagents-"));
	temporaryDirectories.push(path);
	return path;
}

describe("sub-agent configuration", () => {
	it("defaults to the project .pi/agents folder and built-in caps", () => {
		const cfg = resolveSubagentConfig({}, "/work/project");
		assert.equal(cfg.projectDir, join("/work/project", ".pi", "agents"));
		assert.equal(cfg.globalDir, join(getAgentDir(), "agents"));
		assert.equal(cfg.enabled, true);
		assert.equal(cfg.customProjectDir, false);
		assert.equal(cfg.maxTurns, 50);
		assert.equal(cfg.maxDepth, 5);
		assert.equal(cfg.maxConcurrency, 5);
		assert.equal(cfg.defaultModel, undefined);
	});

	it("honours an explicit agents dir and skips the trust gate", () => {
		const cfg = resolveSubagentConfig({ PI_HARNESS_AGENTS_DIR: "~/agents" }, "/work/project");
		assert.equal(cfg.customProjectDir, true);
		assert.ok(cfg.projectDir.endsWith("/agents"));
		assert.ok(!cfg.projectDir.includes("/work/project"));
	});

	it("respects disable flag and numeric overrides", () => {
		const cfg = resolveSubagentConfig(
			{ PI_HARNESS_DISABLE_SUBAGENTS: "1", PI_HARNESS_SUBAGENT_MAX_TURNS: "0", PI_HARNESS_SUBAGENT_MAX_DEPTH: "3", PI_HARNESS_SUBAGENT_MODEL: "haiku" },
			"/work/project",
		);
		assert.equal(cfg.enabled, false);
		assert.equal(cfg.maxTurns, 0);
		assert.equal(cfg.maxDepth, 3);
		assert.equal(cfg.defaultModel, "haiku");
	});
});

describe("session-level sub-agent setting", () => {
	it("restores the latest valid setting and filters its tool snapshot", () => {
		const entries = [
			{ type: "custom", customType: "audited-harness:subagents", data: { enabled: true, restoreTools: ["subagent"] } },
			{ type: "custom", customType: "other", data: { enabled: false, restoreTools: [] } },
			{
				type: "custom",
				customType: "audited-harness:subagents",
				data: { enabled: false, restoreTools: ["subagent", "unknown", "subagent", "steer_subagent"] },
			},
			{ type: "custom", customType: "audited-harness:subagents", data: { enabled: "no", restoreTools: [] } },
		];
		assert.deepEqual(latestSubagentSessionState(entries), {
			enabled: false,
			restoreTools: ["subagent", "steer_subagent"],
		});
	});

	it("removes and restores only sub-agent tools", () => {
		const active = ["read", ...DISPATCH_TOOL_NAMES, "memory"];
		const disabled = updateSubagentTools(active, false);
		assert.deepEqual(disabled, ["read", "memory"]);
		assert.deepEqual(updateSubagentTools(disabled, true, ["subagent", "steer_subagent"]), [
			"read",
			"memory",
			"subagent",
			"steer_subagent",
		]);
	});

	it("/agents off persists the setting, removes the tools, and blocks stale dispatches", async () => {
		type CapturedCommand = {
			handler: (args: string, ctx: { ui: { notify: (message: string, level: string) => void } }) => Promise<void> | void;
		};
		type CapturedTool = {
			execute: (id: string, params: { prompt: string }, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
		};
		let activeTools = ["read", ...DISPATCH_TOOL_NAMES, "memory"];
		let agentsCommand: CapturedCommand | undefined;
		let subagentTool: CapturedTool | undefined;
		const entries: Array<{ customType: string; data: unknown }> = [];
		const notifications: string[] = [];
		type CapturedHook = (event: unknown, ctx: unknown) => Promise<void> | void;
		const hooks = new Map<string, CapturedHook[]>();
		const pi = {
			events: { on() {}, emit() {} },
			on(name: string, handler: CapturedHook) {
				const registered = hooks.get(name) ?? [];
				registered.push(handler);
				hooks.set(name, registered);
			},
			registerTool(tool: { name: string }) {
				if (tool.name === "subagent") subagentTool = tool as unknown as CapturedTool;
			},
			registerCommand(name: string, command: unknown) {
				if (name === "agents") agentsCommand = command as CapturedCommand;
			},
			getActiveTools: () => [...activeTools],
			setActiveTools(tools: string[]) { activeTools = tools; },
			appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
		};
		subagentsExtension(pi as never);
		assert.ok(agentsCommand);
		await agentsCommand.handler("off", { ui: { notify: (message) => notifications.push(message) } });
		assert.deepEqual(activeTools, ["read", "memory"]);
		assert.deepEqual(entries.at(-1), {
			customType: "audited-harness:subagents",
			data: { enabled: false, restoreTools: [...DISPATCH_TOOL_NAMES] },
		});
		assert.match(notifications.at(-1) ?? "", /disabled for this session/);
		assert.ok(subagentTool);
		await assert.rejects(() => subagentTool!.execute("call", { prompt: "work" }, undefined, undefined, {}), /disabled for this session/);

		let branchEntries: unknown[] = [];
		const runtimeCtx = {
			cwd: process.cwd(),
			sessionManager: { getBranch: () => branchEntries },
			ui: { setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
		};
		for (const handler of hooks.get("session_tree") ?? []) await handler({}, runtimeCtx);
		assert.deepEqual(activeTools, ["read", "memory", ...DISPATCH_TOOL_NAMES]);
		branchEntries = [{
			type: "custom",
			customType: "audited-harness:subagents",
			data: { enabled: false, restoreTools: [...DISPATCH_TOOL_NAMES] },
		}];
		for (const handler of hooks.get("session_tree") ?? []) await handler({}, runtimeCtx);
		assert.deepEqual(activeTools, ["read", "memory"]);

		for (const handler of hooks.get("session_shutdown") ?? []) await handler({}, runtimeCtx);
		assert.deepEqual(activeTools, ["read", "memory", ...DISPATCH_TOOL_NAMES]);
	});
});

describe("agent file parsing", () => {
	it("parses frontmatter and treats the body as the system prompt", () => {
		const content = "---\nname: researcher\ndescription: Finds and summarizes sources.\nmodel: haiku\nthinking: high\nmax_turns: 12\ntools:\n  - read\n  - grep\n---\nYou are a researcher.\nBe rigorous.\n";
		const r = parseAgentFile(content, { path: "researcher.md", scope: "project" });
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.def.name, "researcher");
		assert.equal(r.def.description, "Finds and summarizes sources.");
		assert.equal(r.def.systemPrompt, "You are a researcher.\nBe rigorous.");
		assert.deepEqual(r.def.tools, ["read", "grep"]);
		assert.equal(r.def.model, "haiku");
		assert.equal(r.def.thinking, "high");
		assert.equal(r.def.maxTurns, 12);
	});

	it("accepts a file with no frontmatter", () => {
		const r = parseAgentFile("Just a body prompt.", { path: "x.md", scope: "global" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.error, /name/);
	});

	it("rejects a missing description", () => {
		const r = parseAgentFile("---\nname: x\n---\nbody", { path: "x.md", scope: "project" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.error, /description/);
	});

	it("rejects an invalid name", () => {
		const r = parseAgentFile("---\nname: Bad Name\ndescription: x\n---\nbody", { path: "x.md", scope: "project" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.error, /lowercase/);
	});

	it("warns on unknown fields but still registers", () => {
		const r = parseAgentFile("---\nname: x\ndescription: y\nhooks: something\n---\nbody", { path: "x.md", scope: "project" });
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.ok(r.warnings.some((w) => w.includes("hooks")));
	});

	it("rejects an invalid thinking level", () => {
		const r = parseAgentFile("---\nname: x\ndescription: y\nthinking: turbo\n---\nbody", { path: "x.md", scope: "project" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.error, /thinking/);
	});

	it("treats an empty tools list as an explicit no-tools declaration", () => {
		const r = parseAgentFile("---\nname: x\ndescription: y\ntools: []\n---\nbody", { path: "x.md", scope: "project" });
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.deepEqual(r.def.tools, []);
	});
});

describe("built-ins", () => {
	it("ships general-purpose, Explore, and Plan", () => {
		const names = BUILTIN_AGENTS.map((a) => a.name);
		assert.deepEqual(names, ["general-purpose", "Explore", "Plan"]);
		assert.ok(ONESHOT_TYPES.has("explore"));
		assert.ok(ONESHOT_TYPES.has("plan"));
		assert.ok(!ONESHOT_TYPES.has("general-purpose"));
	});
});

describe("discovery & merge", () => {
	it("finds the git repo root, falling back to fs root", async () => {
		const dir = await temporaryDir();
		await mkdir(join(dir, ".git"));
		assert.equal(findRepoRoot(join(dir, "sub", "deep")), dir);
		const noGit = await temporaryDir();
		assert.equal(findRepoRoot(join(noGit, "a")), findRepoRoot(noGit)); // walks to fs root consistently
	});

	it("collects markdown files recursively", async () => {
		const dir = await temporaryDir();
		await mkdir(join(dir, "team"), { recursive: true });
		await writeFile(join(dir, "a.md"), "x");
		await writeFile(join(dir, "team", "b.md"), "x");
		await writeFile(join(dir, "c.txt"), "x");
		const files = collectAgentFiles(dir);
		assert.ok(files.some((f) => f.endsWith("a.md")));
		assert.ok(files.some((f) => f.endsWith("b.md")));
		assert.ok(!files.some((f) => f.endsWith("c.txt")));
	});

	it("discovers project and global agents and respects trust", async () => {
		const project = await temporaryDir();
		await mkdir(join(project, ".pi", "agents"), { recursive: true });
		await writeFile(join(project, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews code\n---\nbe strict");
		const cfg = resolveSubagentConfig({}, project);
		const trusted = await discoverAgents(cfg, project, true);
		assert.ok(findAgent(trusted.agents, "reviewer"));
		assert.ok(findAgent(trusted.agents, "Explore")); // built-in present
		const untrusted = await discoverAgents(cfg, project, false);
		assert.ok(!findAgent(untrusted.agents, "reviewer")); // project agents gated by trust
		assert.ok(findAgent(untrusted.agents, "Explore")); // built-ins still present
	});

	it("mergeAgents applies precedence and case-insensitive dedupe with diagnostics", () => {
		const project = [{ name: "Explore", description: "p", systemPrompt: "p", source: { path: "p", scope: "project" as const } }];
		const global = [{ name: "explore", description: "g", systemPrompt: "g", source: { path: "g", scope: "global" as const } }];
		const merged = mergeAgents([project, global, BUILTIN_AGENTS]);
		const explore = findAgent(merged.agents, "Explore");
		assert.ok(explore);
		assert.equal(explore!.source.scope, "project"); // project wins over global+builtin
		assert.ok(merged.diagnostics.length >= 2); // global + builtin duplicates reported
	});

	it("findAgent matches case-insensitively", () => {
		assert.equal(findAgent(BUILTIN_AGENTS, "PLAN")?.name, "Plan");
		assert.equal(findAgent(BUILTIN_AGENTS, "general-purpose")?.name, "general-purpose");
		assert.equal(findAgent(BUILTIN_AGENTS, "missing"), undefined);
	});
});

describe("effective tool set", () => {
	const def = (tools?: string[]) => ({ name: "x", description: "y", systemPrompt: "z", source: { path: "x.md", scope: "project" as const }, ...(tools ? { tools } : {}) });

	it("inherits the full built-in set plus dispatch tools below the cap", () => {
		const r = computeEffectiveTools({ def: def(), depth: 1, maxDepth: 5, mode: "default" });
		assert.ok(r.tools.includes("bash"));
		assert.ok(r.tools.includes("edit"));
		assert.ok(r.tools.includes("subagent"));
	});

	it("removes dispatch tools when own depth equals the cap", () => {
		const r = computeEffectiveTools({ def: def(), depth: 5, maxDepth: 5, mode: "default" });
		assert.ok(!r.tools.includes("subagent"));
	});

	it("an explicit allowlist replaces the default set", () => {
		const r = computeEffectiveTools({ def: def(["read", "grep"]), depth: 1, maxDepth: 5, mode: "default" });
		assert.ok(r.tools.includes("read"));
		assert.ok(!r.tools.includes("bash"));
		assert.ok(r.tools.includes("subagent")); // dispatch tools still added below cap
	});

	it("restricted modes keep only read-only tools", () => {
		const r = computeEffectiveTools({ def: def(), depth: 1, maxDepth: 5, mode: "inspect" });
		assert.ok(r.tools.includes("read"));
		assert.ok(!r.tools.includes("bash"));
		assert.ok(!r.tools.includes("edit"));
	});

	it("errors when the effective set is empty", () => {
		const r = computeEffectiveTools({ def: def(["edit", "write"]), depth: 5, maxDepth: 5, mode: "inspect" });
		assert.equal(r.tools.length, 0);
		assert.ok(r.error);
	});
});

describe("resolution helpers", () => {
	it("resolveModelSpec honours call > def > env and treats inherit as unset", () => {
		assert.equal(resolveModelSpec(undefined, undefined, undefined), undefined);
		assert.equal(resolveModelSpec(undefined, undefined, "haiku"), "haiku");
		assert.equal(resolveModelSpec("sonnet", "haiku", "opus"), "sonnet");
		assert.equal(resolveModelSpec("inherit", "haiku", undefined), undefined);
	});

	it("resolveThinking honours call > def and clamps unknown to inherit", () => {
		assert.equal(resolveThinking("low", "high"), "low");
		assert.equal(resolveThinking(undefined, "high"), "high");
		assert.equal(resolveThinking("inherit", "high"), "inherit");
		assert.equal(resolveThinking("garbage", undefined), "inherit");
	});

	it("resolveMaxTurns honours call > def > config (0 = uncapped)", () => {
		assert.equal(resolveMaxTurns(5, 10, 50), 5);
		assert.equal(resolveMaxTurns(undefined, 10, 50), 10);
		assert.equal(resolveMaxTurns(undefined, undefined, 50), 50);
		assert.equal(resolveMaxTurns(0, 10, 50), 0);
	});
});

describe("prompt block & helpers", () => {
	it("emits a registry block listing agents below the depth cap", () => {
		const block = buildAgentsPrompt(BUILTIN_AGENTS, { depth: 0, maxDepth: 5 });
		assert.match(block, /Sub-agents/);
		assert.match(block, /general-purpose/);
		assert.match(block, /Explore/);
		assert.ok(block.includes(SUBAGENT_DECISION_GUIDANCE));
		assert.match(block, /Delegate when the expected improvement in quality, latency, or isolation exceeds/);
	});

	it("emits nothing at the depth cap", () => {
		assert.equal(buildAgentsPrompt(BUILTIN_AGENTS, { depth: 5, maxDepth: 5 }), "");
	});

	it("generates unique, well-formed ids", () => {
		const a = generateAgentId();
		const b = generateAgentId();
		assert.match(a, /^sa_/);
		assert.notEqual(a, b);
	});

	it("extracts the last assistant text from a message list", () => {
		assert.equal(extractFinalText([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]), "hello");
		assert.equal(
			extractFinalText([{ role: "assistant", content: [{ type: "text", text: "part " }, { type: "text", text: "two" }] }]),
			"part two",
		);
		assert.equal(extractFinalText([{ role: "user", content: "hi" }]), "");
	});
});

describe("active sub-agent counting", () => {
	it("counts only runs whose status is still running", () => {
		const runs: { status: "running" | "completed" | "errored" | "aborted" }[] = [
			{ status: "running" },
			{ status: "running" },
			{ status: "completed" },
			{ status: "errored" },
			{ status: "aborted" },
			{ status: "running" },
		];
		assert.equal(countActiveRuns(runs), 3);
	});

	it("returns 0 when no runs are running", () => {
		assert.equal(countActiveRuns([{ status: "completed" as const }, { status: "aborted" as const }]), 0);
	});

	it("returns 0 for an empty iterable", () => {
		assert.equal(countActiveRuns([]), 0);
	});
});
