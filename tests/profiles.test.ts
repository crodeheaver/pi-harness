import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import {
	latestProfileState,
	listProfiles,
	loadProfileDefinition,
	parseProfileSettings,
	type ProfileState,
} from "../extensions/profiles.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryProject(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-harness-profile-"));
	temporaryDirectories.push(path);
	return path;
}

describe("profile discovery", () => {
	it("lists only direct profile directories in stable order", async () => {
		const cwd = await temporaryProject();
		await mkdir(join(cwd, "pi", "zeta"), { recursive: true });
		await mkdir(join(cwd, "pi", "alpha"));
		await writeFile(join(cwd, "pi", "not-a-profile"), "file");
		assert.deepEqual(await listProfiles(cwd), ["alpha", "zeta"]);
	});

	it("loads conventional and configured resources plus instructions", async () => {
		const cwd = await temporaryProject();
		const profile = join(cwd, "pi", "review");
		await mkdir(join(profile, "skills"), { recursive: true });
		await mkdir(join(profile, "extra-prompts"));
		await mkdir(join(profile, "+literal-theme"));
		await writeFile(join(profile, "APPEND_SYSTEM.md"), "Profile file instructions.");
		await writeFile(join(profile, "settings.json"), JSON.stringify({
			defaultProvider: "anthropic",
			defaultModel: "claude-test",
			defaultThinkingLevel: "high",
			prompts: ["extra-prompts"],
			themes: ["+literal-theme"],
			instructions: "Configured instructions.",
		}));

		const loaded = await loadProfileDefinition(cwd, "review");
		assert.deepEqual(loaded.skillPaths, [join(profile, "skills")]);
		assert.deepEqual(loaded.promptPaths, [join(profile, "extra-prompts")]);
		assert.deepEqual(loaded.themePaths, [join(profile, "+literal-theme")]);
		assert.equal(loaded.settings.defaultThinkingLevel, "high");
		assert.equal(loaded.instructions, "Configured instructions.\n\nProfile file instructions.");
	});

	it("rejects unknown names and resource paths outside the profile", async () => {
		const cwd = await temporaryProject();
		const profile = join(cwd, "pi", "unsafe");
		await mkdir(profile, { recursive: true });
		await assert.rejects(() => loadProfileDefinition(cwd, "../unsafe"), /Unknown profile/);
		await writeFile(join(profile, "settings.json"), JSON.stringify({ skills: ["../../outside"] }));
		await assert.rejects(() => loadProfileDefinition(cwd, "unsafe"), /escapes the profile/);
	});
});

describe("profile settings and state", () => {
	it("validates settings fields", () => {
		assert.deepEqual(parseProfileSettings({ tools: ["read"], theme: "dark" }).tools, ["read"]);
		assert.throws(() => parseProfileSettings({ tools: "read" }), /tools must be an array/);
		assert.throws(() => parseProfileSettings({ defaultThinkingLevel: "huge" }), /defaultThinkingLevel/);
	});

	it("restores the newest profile state entry", () => {
		const baseline = { thinkingLevel: "low" as const, tools: ["read"] };
		const expected: ProfileState = { name: "second", baseline };
		assert.deepEqual(latestProfileState([
			{ type: "custom", customType: "audited-harness:active-profile", data: { name: "ignored", baseline: { thinkingLevel: "invalid", tools: [] } } },
			{ type: "custom", customType: "audited-harness:active-profile", data: { name: "first", baseline } },
			{ type: "message" },
			{ type: "custom", customType: "audited-harness:active-profile", data: expected },
		]), expected);
	});
});
