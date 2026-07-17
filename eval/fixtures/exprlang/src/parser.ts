import type { Expr, Token } from "./types.ts";

/**
 * Recursive-descent parser.
 *
 * Grammar (lowest precedence first):
 *   expr           := additive
 *   additive       := multiplicative (("+" | "-") multiplicative)*
 *   multiplicative := unary (("*" | "/" | "%") unary)*
 *   unary          := "-" unary | power
 *   power          := primary ("^" primary)*
 *   primary        := NUMBER | IDENT | IDENT "(" args ")" | "(" expr ")"
 */
export function parse(tokens: Token[]): Expr {
  const parser = new Parser(tokens);
  const expr = parser.parseExpr();
  parser.expectEof();
  return expr;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parseExpr(): Expr {
    return this.parseAdditive();
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().value as string;
      const right = this.parseMultiplicative();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next().value as string;
      const right = this.parseUnary();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp("-")) {
      this.next();
      return { type: "unary", op: "-", operand: this.parseUnary() };
    }
    return this.parsePower();
  }

  // Power operator. Mathematically `^` is right-associative, so
  // `2 ^ 3 ^ 2` should parse as `2 ^ (3 ^ 2)`.
  private parsePower(): Expr {
    let left = this.parsePrimary();
    while (this.isOp("^")) {
      this.next();
      const right = this.parsePrimary();
      left = { type: "binary", op: "^", left, right };
    }
    return left;
  }

  private parsePrimary(): Expr {
    const token = this.peek();

    if (token.kind === "number") {
      this.next();
      return { type: "num", value: token.value };
    }

    if (token.kind === "ident") {
      this.next();
      if (this.peek().kind === "lparen") {
        this.next();
        const args: Expr[] = [];
        if (this.peek().kind !== "rparen") {
          args.push(this.parseExpr());
          while (this.peek().kind === "comma") {
            this.next();
            args.push(this.parseExpr());
          }
        }
        this.expect("rparen");
        return { type: "call", name: token.value, args };
      }
      return { type: "var", name: token.value };
    }

    if (token.kind === "lparen") {
      this.next();
      const inner = this.parseExpr();
      this.expect("rparen");
      return inner;
    }

    throw new Error(`Unexpected token ${JSON.stringify(token)}`);
  }

  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.value === value;
  }

  private expect(kind: Token["kind"]): Token {
    const t = this.peek();
    if (t.kind !== kind) throw new Error(`Expected ${kind} but got ${JSON.stringify(t)}`);
    return this.next();
  }

  expectEof(): void {
    this.expect("eof");
  }
}
