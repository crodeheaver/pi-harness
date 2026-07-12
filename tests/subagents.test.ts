import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	BUILTIN_AGENTS,
	ONESHOT_TYPES,
	buildAgentsPrompt,
	collectAgentFiles,
	computeEffectiveTools,
	discoverAgents,
	extractFinalText,
	findAgent,
	findRepoRoot,
	generateAgentId,
	mergeAgents,
	parseAgentFile,
	resolveMaxTurns,
	resolveModelSpec,
	resolveSubagentConfig,
	resolveThinking,
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
