import type { Expr } from "./types.ts";

export type Env = Record<string, number>;

const DEFAULT_ENV: Env = {
  pi: Math.PI,
  e: Math.E,
};

type Builtin = (...args: number[]) => number;

const BUILTINS: Record<string, Builtin> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
};

/** Evaluate an AST to a number using the given variable environment. */
export function evaluate(expr: Expr, env: Env = DEFAULT_ENV): number {
  switch (expr.type) {
    case "num":
      return expr.value;
    case "var": {
      const value = env[expr.name];
      if (value === undefined) throw new Error(`Unknown variable: ${expr.name}`);
      return value;
    }
    case "unary":
      return -evaluate(expr.operand, env);
    case "binary":
      return applyBinary(expr.op, evaluate(expr.left, env), evaluate(expr.right, env));
    case "call": {
      const fn = BUILTINS[expr.name];
      if (!fn) throw new Error(`Unknown function: ${expr.name}`);
      return fn(...expr.args.map((a) => evaluate(a, env)));
    }
  }
}

function applyBinary(op: string, left: number, right: number): number {
  switch (op) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": return left / right;
    case "%": return left % right;
    case "^": return Math.pow(left, right);
    default: throw new Error(`Unknown operator: ${op}`);
  }
}
