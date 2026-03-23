import { describe, expect, test } from "bun:test";
import { detectAuthError } from "@pi-acp/acp/auth-required";

describe("detectAuthError", () => {
	test("detects 'api key' error", () => {
		const err = new Error("Missing API key for provider");
		const result = detectAuthError(err);
		expect(result).not.toBeNull();
	});

	test("detects 'unauthorized' error", () => {
		const err = new Error("Request returned unauthorized");
		const result = detectAuthError(err);
		expect(result).not.toBeNull();
	});

	test("detects '401' error", () => {
		const err = new Error("HTTP 401 response");
		const result = detectAuthError(err);
		expect(result).not.toBeNull();
	});

	test("detects '403' error", () => {
		const err = new Error("HTTP 403 Forbidden");
		const result = detectAuthError(err);
		expect(result).not.toBeNull();
	});

	test("detects 'not configured' error", () => {
		const err = new Error("Provider not configured");
		const result = detectAuthError(err);
		expect(result).not.toBeNull();
	});

	test("returns null for generic errors", () => {
		const err = new Error("Connection timeout");
		const result = detectAuthError(err);
		expect(result).toBeNull();
	});

	test("returns null for null input", () => {
		const result = detectAuthError(null);
		expect(result).toBeNull();
	});

	test("handles string errors", () => {
		const result = detectAuthError("missing api key");
		expect(result).not.toBeNull();
	});

	test("handles non-auth string errors", () => {
		const result = detectAuthError("file not found");
		expect(result).toBeNull();
	});
});
