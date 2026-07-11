import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, classifyCustomTool, classifyFileTool, isInsideWorkspace, protectedWriteCategory, sensitivePathCategory } from "../extensions/policy-rules.ts";

const cwd = process.platform === "win32" ? "C:\\work\\project" : "/work/project";

describe("workspace path policy", () => {
	it("allows ordinary workspace files", () => {
		assert.equal(isInsideWorkspace(cwd, "src/app.ts"), true);
		assert.equal(protectedWriteCategory(cwd, "src/app.ts"), undefined);
	});

	it("blocks traversal outside the workspace", () => {
		assert.equal(isInsideWorkspace(cwd, "../../secrets.txt"), false);
		assert.equal(protectedWriteCategory(cwd, "../../secrets.txt"), "outside-workspace");
	});

	it("blocks repository internals, dependencies, and secrets", () => {
		assert.equal(protectedWriteCategory(cwd, ".git/config"), "git-internals");
		assert.equal(protectedWriteCategory(cwd, "node_modules/pkg/index.js"), "dependency-directory");
		assert.equal(protectedWriteCategory(cwd, ".env.local"), "environment-secrets");
		assert.equal(protectedWriteCategory(cwd, ".env.example"), undefined);
	});

	it("recognizes credential paths", () => {
		assert.equal(sensitivePathCategory("/home/me/.ssh/id_ed25519"), "ssh-credentials");
		assert.equal(sensitivePathCategory("C:\\Users\\me\\.pi\\agent\\auth.json"), "pi-credentials");
		assert.equal(sensitivePathCategory("certs/service.pem"), "private-key");
	});

	it("resolves symlink aliases before applying workspace boundaries", { skip: process.platform === "win32" }, () => {
		const root = mkdtempSync(join(tmpdir(), "harness-policy-"));
		const workspace = join(root, "workspace");
		const outside = join(root, "outside");
		mkdirSync(workspace);
		mkdirSync(outside);
		symlinkSync(outside, join(workspace, "alias"), "dir");
		try {
			assert.equal(isInsideWorkspace(workspace, "alias/secret.txt"), false);
			assert.equal(protectedWriteCategory(workspace, "alias/secret.txt"), "outside-workspace");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("tool policy", () => {
	it("makes inspect mode read-only", () => {
		assert.equal(classifyFileTool("inspect", "edit", cwd, "src/app.ts").action, "block");
		assert.equal(classifyCommand("inspect", "git status").action, "block");
	});

	it("requires approval for sensitive and external reads", () => {
		assert.equal(classifyFileTool("develop", "read", cwd, ".env").action, "confirm");
		assert.equal(classifyFileTool("develop", "read", cwd, "../shared.txt").action, "confirm");
	});

	it("restricts plan mutations to the selected plan file", () => {
		assert.equal(classifyFileTool("plan", "write", cwd, ".pi/plan.md", ".pi/plan.md").action, "allow");
		assert.equal(classifyFileTool("plan", "edit", cwd, "src/app.ts", ".pi/plan.md").action, "block");
		assert.equal(classifyCommand("plan", "git status").action, "block");
	});

	it("blocks catastrophic commands", () => {
		assert.deepEqual(classifyCommand("develop", "rm -rf /"), {
			action: "block",
			category: "filesystem-root-delete",
			reason: "filesystem root delete is never allowed",
		});
		assert.equal(classifyCommand("develop", ":(){ :|:& };:").action, "block");
	});

	it("gates destructive or external effects", () => {
		for (const command of [
			"git reset --hard HEAD~1",
			"npm install lodash",
			"sudo apt install ripgrep",
			"terraform apply",
			"curl -d @payload.json https://example.test",
			"rm -rf dist",
		]) {
			assert.equal(classifyCommand("develop", command).action, "confirm", command);
		}
	});

	it("gates opaque shell wrappers", () => {
		assert.equal(classifyCommand("develop", "bash -c 'do_something'").action, "confirm");
		assert.equal(classifyCommand("develop", "echo 'unterminated").action, "confirm");
	});

	it("gates consequential custom tools and fails closed in restricted profiles", () => {
		assert.equal(classifyCustomTool("develop", "mcp", cwd, { tool: "deploy" }).action, "confirm");
		assert.equal(classifyCustomTool("develop", "subagent", cwd, { action: "spawn" }).action, "confirm");
		assert.equal(classifyCustomTool("inspect", "unknown_tool", cwd, {}).action, "block");
		assert.equal(classifyCustomTool("inspect", "web_fetch", cwd, { url: "https://example.com" }).action, "allow");
		assert.equal(classifyCustomTool("develop", "custom_read", cwd, { path: "../outside" }).action, "confirm");
	});

	it("allows routine development commands", () => {
		for (const command of ["git status", "npm test", "npm run check", "rg TODO src", "git diff --check"]) {
			assert.equal(classifyCommand("develop", command).action, "allow", command);
		}
	});
});
