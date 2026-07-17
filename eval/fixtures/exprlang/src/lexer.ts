import type { Token } from "./types.ts";

const OPERATORS = new Set(["+", "-", "*", "/", "%", "^"]);

/**
 * Convert a source string into a flat list of tokens, ending with `eof`.
 * Whitespace is skipped. Unknown characters throw with their position.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "comma" }); i++; continue; }

    if (OPERATORS.has(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      while (i < source.length && isDigit(source[i]!)) i++;
      if (source[i] === ".") {
        i++;
        while (i < source.length && isDigit(source[i]!)) i++;
      }
      tokens.push({ kind: "number", value: Number(source.slice(start, i)) });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i]!)) i++;
      tokens.push({ kind: "ident", value: source.slice(start, i) });
      continue;
    }

    throw new Error(`Unexpected character ${JSON.stringify(ch)} at position ${i}`);
  }

  tokens.push({ kind: "eof" });
  return tokens;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
