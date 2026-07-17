# exprlang

A small, dependency-free arithmetic expression evaluator with a CLI.

## What it does

Parses and evaluates arithmetic expressions with:

- numbers (integer and float)
- binary operators: `+` `-` `*` `/` `%` `^` (power)
- unary minus: `-x`
- grouping with parentheses
- named variables: `pi`, `e`
- builtin functions: `sqrt`, `abs`, `floor`, `ceil`, `round`, `max`, `min`, `pow`

## Layout

- `src/types.ts` — token and AST node definitions
- `src/lexer.ts` — turns a source string into a token stream
- `src/parser.ts` — recursive-descent parser producing an AST
- `src/evaluator.ts` — walks the AST and computes a number
- `src/cli.ts` — command-line entry point
- `test/eval.test.ts` — behavior tests (run with `bun test`)

## Usage

```
bun run src/cli.ts "2 + 3 * 4"      # 14
bun run src/cli.ts "sqrt(16) + 1"   # 5
bun run src/cli.ts "(1 + 2) ^ 3"    # 27
```

## Operator precedence (low to high)

1. `+` `-`
2. `*` `/` `%`
3. unary `-`
4. `^` (power)
5. grouping / calls / literals

Power is intended to be **right-associative**, matching standard mathematical
convention: `2 ^ 3 ^ 2` should evaluate as `2 ^ (3 ^ 2)` = `2 ^ 9` = `512`.
