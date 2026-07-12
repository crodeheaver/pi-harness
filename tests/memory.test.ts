import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	MEMORY_FILE,
	buildMemoryPrompt,
	headOf,
	listMemoryFiles,
	resolveMemoryConfig,
	safeMemoryPath,
} from "../extensions/memory.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-harness-memory-"));
	temporaryDirectories.push(path);
	return path;
}

describe("memory configuration", () => {
	it("defaults to the project .pi/memory folder", () => {
		const cfg = resolveMemoryConfig({}, "/work/project");
		assert.equal(cfg.dir, join("/work/project", ".pi", "memory"));
		assert.equal(cfg.enabled, true);
		assert.equal(cfg.custom, false);
	});

	it("honours an explicit absolute directory and skips the trust gate", () => {
		const cfg = resolveMemoryConfig({ PI_HARNESS_MEMORY_DIR: "/elsewhere/mem" }, "/work/project");
		assert.equal(cfg.dir, "/elsewhere/mem");
		assert.equal(cfg.custom, true);
	});

	it("expands ~ in an explicit directory", () => {
		const cfg = resolveMemoryConfig({ PI_HARNESS_MEMORY_DIR: "~/mem" }, "/work/project");
		assert.ok(cfg.dir.includes("mem"));
		assert.ok(!cfg.dir.includes("~"));
		assert.equal(cfg.custom, true);
	});

	it("resolves a relative explicit directory against the project", () => {
		const cfg = resolveMemoryConfig({ PI_HARNESS_MEMORY_DIR: "shared/mem" }, "/work/project");
		assert.equal(cfg.dir, join("/work/project", "shared", "mem"));
	});

	it("disables via either env flag", () => {
		assert.equal(resolveMemoryConfig({ PI_HARNESS_AUTO_MEMORY: "0" }, "/p").enabled, false);
		assert.equal(resolveMemoryConfig({ PI_HARNESS_DISABLE_AUTO_MEMORY: "1" }, "/p").enabled, false);
		assert.equal(resolveMemoryConfig({ PI_HARNESS_AUTO_MEMORY: "1" }, "/p").enabled, true);
	});
});

describe("memory path resolution", () => {
	const dir = "/work/project/.pi/memory";

	it("defaults to MEMORY.md", () => {
		assert.equal(safeMemoryPath(dir, undefined), join(dir, MEMORY_FILE));
		assert.equal(safeMemoryPath(dir, "   "), join(dir, MEMORY_FILE));
	});

	it("forces a .md extension", () => {
		assert.equal(safeMemoryPath(dir, "conventions"), join(dir, "conventions.md"));
		assert.equal(safeMemoryPath(dir, "conventions.md"), join(dir, "conventions.md"));
	});

	it("allows subdirectories", () => {
		assert.equal(safeMemoryPath(dir, "notes/api"), join(dir, "notes", "api.md"));
	});

	it("rejects absolute paths", () => {
		assert.throws(() => safeMemoryPath(dir, "/etc/passwd"), /relative path/);
	});

	it("rejects parent traversal in any form", () => {
		assert.throws(() => safeMemoryPath(dir, "../escape"), /memory directory/);
		assert.throws(() => safeMemoryPath(dir, "ok/../../escape"), /memory directory/);
		assert.throws(() => safeMemoryPath(dir, ".."), /memory directory/);
	});

	it("rejects unsafe characters and NUL bytes", () => {
		assert.throws(() => safeMemoryPath(dir, "bad name;rm"), /invalid file name segment/);
		assert.throws(() => safeMemoryPath(dir, "ok\0bad"), /NUL byte/);
	});
});

describe("MEMORY.md head truncation", () => {
	it("returns the full text when within limits", () => {
		const { text, truncated } = headOf("line one\nline two", 200, 25_000);
		assert.equal(text, "line one\nline two");
		assert.equal(truncated, false);
	});

	it("caps to a maximum number of lines", () => {
		const big = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
		const { text, truncated } = headOf(big);
		assert.equal(truncated, true);
		assert.equal(text.split("\n").length, 200);
	});

	it("caps to a maximum byte budget", () => {
		const { text, truncated } = headOf("a".repeat(1000), 200, 100);
		assert.equal(truncated, true);
		assert.ok(Buffer.byteLength(text, "utf8") <= 100);
	});
});

describe("memory file listing", () => {
	it("lists markdown files with line counts and a title, ignoring non-markdown", async () => {
		const dir = await temporaryDir();
		await mkdir(join(dir, "notes"), { recursive: true });
		await writeFile(join(dir, MEMORY_FILE), "# Index\n\n- fact one\n");
		await writeFile(join(dir, "api.md"), "## API conventions\n\nUse PUT for updates.\n");
		await writeFile(join(dir, "ignore.txt"), "not memory\n");
		const files = await listMemoryFiles(dir);
		assert.deepEqual(
			files.map((f) => f.name),
			["MEMORY.md", "api.md"],
		);
		assert.equal(files[0]?.lines, 3);
		assert.equal(files[0]?.title, "Index");
		assert.equal(files[1]?.title, "API conventions");
	});

	it("returns an empty list when the directory is absent", async () => {
		const files = await listMemoryFiles(join(await temporaryDir(), "missing"));
		assert.deepEqual(files, []);
	});
});

describe("system prompt builder", () => {
	it("includes the head, topic files, and save guidance", () => {
		const prompt = buildMemoryPrompt({
			cwd: "/work/project",
			dir: "/work/project/.pi/memory",
			head: "- prefers tabs",
			files: [{ name: MEMORY_FILE, lines: 1, title: "prefs" }, { name: "api.md", lines: 12, title: "API conventions" }],
			saveNudge: true,
		});
		assert.ok(prompt.includes("## Project memory"));
		assert.ok(prompt.includes("- prefers tabs"));
		assert.ok(prompt.includes("api.md (12 lines: API conventions)"));
		assert.ok(prompt.includes("action `save`"));
	});

	it("notes an empty memory and omits the save nudge when requested", () => {
		const prompt = buildMemoryPrompt({
			cwd: "/work/project",
			dir: "/work/project/.pi/memory",
			head: undefined,
			files: [],
			saveNudge: false,
		});
		assert.ok(prompt.includes("No memories saved yet"));
		assert.ok(!prompt.includes("action `save`"));
	});
});
