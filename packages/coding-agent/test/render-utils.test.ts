import { describe, expect, it } from "vitest";
import { getTextOutput } from "../src/core/tools/render-utils.ts";

describe("getTextOutput", () => {
	it("returns empty string when result is undefined", () => {
		expect(getTextOutput(undefined, false)).toBe("");
	});

	it("returns empty string when result has no content", () => {
		expect(getTextOutput({} as any, false)).toBe("");
	});

	it("returns empty string when content is not an array", () => {
		expect(getTextOutput({ content: "plain string" } as any, false)).toBe("");
	});

	it("returns empty string when content is a string-valued object", () => {
		expect(getTextOutput({ content: { type: "text", text: "oops" } } as any, false)).toBe("");
	});

	it("joins text blocks", () => {
		const result = {
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			],
		};
		expect(getTextOutput(result as any, false)).toBe("hello\nworld");
	});
});
