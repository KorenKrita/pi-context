import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { evaluate } from "./evaluator.ts";

/** Evaluate a single expression string end to end. */
export function run(source: string): number {
  return evaluate(parse(tokenize(source)));
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error('usage: cli.ts "<expression>"');
    process.exit(1);
  }
  const source = args.join(" ");
  const result = run(source);
  console.log(String(result));
}

if (import.meta.main) {
  main(process.argv);
}
