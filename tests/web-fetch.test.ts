import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToText, isBlockedAddress, validatePublicUrl } from "../extensions/web-fetch.ts";

describe("web fetch network guards", () => {
	it("blocks local, private, link-local, and reserved addresses", () => {
		for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "192.0.2.1", "198.51.100.1", "203.0.113.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
			assert.equal(isBlockedAddress(address), true, address);
		}
		assert.equal(isBlockedAddress("93.184.216.34"), false);
		assert.equal(isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
	});

	it("rejects non-http schemes, embedded credentials, and local hostnames", async () => {
		await assert.rejects(validatePublicUrl("file:///etc/passwd"), /HTTP/);
		await assert.rejects(validatePublicUrl("https://user:pass@example.com"), /Credentials/);
		await assert.rejects(validatePublicUrl("http://localhost/test"), /Local hostnames/);
		await assert.rejects(validatePublicUrl("http://127.0.0.1/test"), /Private/);
	});
});

describe("web fetch extraction", () => {
	it("removes executable markup and keeps readable structure", () => {
		const text = htmlToText("<html><style>x{}</style><script>alert(1)</script><h1>A &amp; B</h1><p>Hello<br>world</p></html>");
		assert.equal(text, "A & B\n\nHello\nworld");
	});
});
