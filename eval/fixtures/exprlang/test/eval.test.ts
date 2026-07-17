import { test, expect } from "bun:test";
import { run } from "../src/cli.ts";

test("addition and precedence", () => {
  expect(run("2 + 3 * 4")).toBe(14);
});

test("parentheses override precedence", () => {
  expect(run("(2 + 3) * 4")).toBe(20);
});

test("unary minus", () => {
  expect(run("-3 + 5")).toBe(2);
});

test("modulo", () => {
  expect(run("10 % 3")).toBe(1);
});

test("single power", () => {
  expect(run("2 ^ 3")).toBe(8);
});

test("builtins", () => {
  expect(run("sqrt(16)")).toBe(4);
  expect(run("max(2, 9, 5)")).toBe(9);
});

test("variables", () => {
  expect(run("floor(pi)")).toBe(3);
});
