export type Token =
  | { kind: "number"; value: number }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" }
  | { kind: "eof" };

export type Expr =
  | { type: "num"; value: number }
  | { type: "var"; name: string }
  | { type: "unary"; op: string; operand: Expr }
  | { type: "binary"; op: string; left: Expr; right: Expr }
  | { type: "call"; name: string; args: Expr[] };
