import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import {
	applyEnvironment,
	extractEnvironment,
	parseEnvironmentObject,
	readSettings,
} from "../extensions/environment.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-harness-env-"));
	temporaryDirectories.push(path);
	return path;
}

describe("environment parsing", () => {
	it("coerces string, number, and boolean values", () => {
		assert.deepEqual(parseEnvironmentObject({ KEY: "v", PORT: 3000, FLAG: true }, "settings"), {
			KEY: "v",
			PORT: "3000",
			FLAG: "true",
		});
	});

	it("treats null and undefined as absent", () => {
		assert.equal(parseEnvironmentObject(undefined, "settings"), undefined);
		assert.equal(parseEnvironmentObject(null, "settings"), undefined);
	});

	it("rejects non-object shapes", () => {
		assert.throws(() => parseEnvironmentObject("x", "settings"), /environment must be an object/);
		assert.throws(() => parseEnvironmentObject(["a"], "settings"), /environment must be an object/);
	});

	it("rejects nested and null values with a labeled message", () => {
		assert.throws(() => parseEnvironmentObject({ BAD: { nested: 1 } }, "~/.pi/agent/settings.json"), /environment\.BAD/);
		assert.throws(() => parseEnvironmentObject({ BAD: null }, "settings"), /environment\.BAD/);
	});
});

describe("environment extraction from settings", () => {
	it("reads the canonical environment key", () => {
		assert.deepEqual(extractEnvironment({ environment: { A: "1" } }, "settings"), { A: "1" });
	});

	it("falls back to the ENVIRONMENT alias", () => {
		assert.deepEqual(extractEnvironment({ ENVIRONMENT: { A: "2" } }, "settings"), { A: "2" });
	});

	it("prefers environment over ENVIRONMENT when both are present", () => {
		assert.deepEqual(extractEnvironment({ environment: { A: "win" }, ENVIRONMENT: { A: "lose" } }, "settings"), { A: "win" });
	});

	it("returns undefined when no key is present or settings is not an object", () => {
		assert.equal(extractEnvironment({}, "settings"), undefined);
		assert.equal(extractEnvironment(null, "settings"), undefined);
		assert.equal(extractEnvironment([], "settings"), undefined);
	});

	it("surfaces validation errors from a malformed value", () => {
		assert.throws(() => extractEnvironment({ environment: { X: [] } }, "settings"), /environment\.X/);
	});
});

describe("settings file reading", () => {
	it("returns undefined when the file is missing", async () => {
		assert.equal(await readSettings(join(await temporaryDir(), "missing.json"), "settings"), undefined);
	});

	it("parses valid JSON", async () => {
		const dir = await temporaryDir();
		const path = join(dir, "settings.json");
		await writeFile(path, JSON.stringify({ environment: { A: "1" } }));
		assert.deepEqual(await readSettings(path, "settings"), { environment: { A: "1" } });
	});

	it("throws a labeled error on invalid JSON", async () => {
		const dir = await temporaryDir();
		const path = join(dir, ".pi", "settings.json");
		await mkdir(join(dir, ".pi"), { recursive: true });
		await writeFile(path, "{ not json");
		await assert.rejects(() => readSettings(path, ".pi/settings.json"), /invalid JSON/);
	});
});

describe("environment application", () => {
	it("overwrites values on a target record and returns the keys set", () => {
		const target: Record<string, string | undefined> = { EXISTING: "old", KEEP: "kept" };
		const applied = applyEnvironment({ EXISTING: "new", ADDED: "1" }, target);
		assert.deepEqual(target, { EXISTING: "new", KEEP: "kept", ADDED: "1" });
		assert.deepEqual(applied, ["EXISTING", "ADDED"]);
	});
});
