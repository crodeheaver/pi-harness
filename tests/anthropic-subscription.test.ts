import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anthropicAuthMode } from "../extensions/anthropic-subscription.ts";

describe("Anthropic subscription auth classification", () => {
	it("recognizes stored Anthropic OAuth", () => {
		assert.equal(anthropicAuthMode("anthropic", true, ["pi"]), "subscription");
	});

	it("does not treat API credentials or other providers as subscription auth", () => {
		assert.equal(anthropicAuthMode("anthropic", false, ["pi"]), "not-subscription");
		assert.equal(anthropicAuthMode("openai", true, ["pi"]), "not-anthropic");
	});

	it("detects an explicit API-key override", () => {
		assert.equal(anthropicAuthMode("anthropic", true, ["pi", "--api-key", "secret"]), "api-key-override");
		assert.equal(anthropicAuthMode("anthropic", true, ["pi", "--api-key=secret"]), "api-key-override");
	});
});
