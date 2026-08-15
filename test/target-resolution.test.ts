import { describe, expect, test } from "bun:test";
import { extractTextFromContent, extractTextFromContentBounded } from "../src/target-resolution.js";

describe("bounded content extraction", () => {
 test("marks an exact-cap prefix partial without reading unvisited parts", () => {
  let tailReads = 0;
  const tail = {
   type: "text",
   get text() {
    tailReads += 1;
    return "UNIQUE_TAIL_NEEDLE";
   },
  };

  const result = extractTextFromContentBounded([
   { type: "text", text: "xxxx" },
   { type: "toolCall", id: "call-1", name: "read" },
   tail,
  ], 4);

  expect(result).toEqual({ text: "xxxx", sourceCharsConsumed: 4, truncated: true });
  expect(tailReads).toBe(0);
 });

 test("charges trim-independent source work while preserving full-render semantics", () => {
  const stringContent = "   hello   ";
  const arrayContent = [
   { type: "text", text: "   hello" },
   { type: "toolCall", id: "call-1", name: "read" },
   { type: "text", text: "world   " },
  ];

  expect(extractTextFromContentBounded(stringContent, 100)).toEqual({
   text: extractTextFromContent(stringContent),
   sourceCharsConsumed: stringContent.length,
   truncated: false,
  });
  expect(extractTextFromContentBounded(arrayContent, 100)).toEqual({
   text: extractTextFromContent(arrayContent),
   sourceCharsConsumed: "   hello  world   ".length,
   truncated: false,
  });

  const whitespace = extractTextFromContentBounded(" ".repeat(8), 4);
  expect(whitespace).toEqual({ text: "", sourceCharsConsumed: 4, truncated: true });
 });

 test("reads each visited text getter once", () => {
  let reads = 0;
  const statefulPart = {
   type: "text",
   get text() {
    reads += 1;
    return reads === 1 ? "abc" : null;
   },
  };

  expect(extractTextFromContentBounded([statefulPart], 10)).toEqual({
   text: "abc",
   sourceCharsConsumed: 3,
   truncated: false,
  });
  expect(reads).toBe(1);
 });
});
