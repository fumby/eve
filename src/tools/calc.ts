// A pocket calculator: pure arithmetic, evaluated by a hand-rolled
// recursive-descent parser — never eval(), never the shell. This exists
// because the identity tells EVE "when something is mechanically checkable,
// check it with a tool instead of trusting your head", and until now the only
// local path to a number was run_command — which is gated, so she had to ask
// permission to add two numbers. That friction is exactly how arithmetic
// mistakes survive: the check that costs a confirmation never happens.
//
// Grammar (precedence low → high):  + - |  * / % |  ^ (right-assoc) |  unary - |  primary
// Numbers: integers, decimals, underscores as digit separators (1_000_000),
// and a trailing % sign meaning /100 (so "34%" and "0.34" are the same thing —
// margins and fees come at you as percentages).
// REJECTED on purpose: everything else — variables, functions, commas, any
// letter. A letter can only be an attempt to smuggle something past the parser.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
const OPERATORS = "+-*/%^" as const;
type Op = (typeof OPERATORS)[number];

function isOp(c: string): c is Op {
  // Spelled out instead of an array lookup: the tuple type refuses the
  // string->array cast, and six comparisons cost nothing.
  return c === "+" || c === "-" || c === "*" || c === "/" || c === "%" || c === "^";
}

// ── tokenizer ──────────────────────────────────────────────────────────────
interface Tok {
  kind: "num" | "op" | "lparen" | "rparen";
  value: number | Op;
}

function tokenize(src: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    // All whitespace is free — a formula pasted from a note may carry newlines.
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ kind: "lparen", value: "(" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ kind: "rparen", value: ")" });
      i++;
      continue;
    }
    if (isOp(c)) {
      toks.push({ kind: "op", value: c });
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let num = "";
      let percent = false;
      while (i < src.length && /[0-9._]/.test(src[i]!)) {
        // An underscore must sit BETWEEN digits — a separator, not a prefix.
        if (src[i] === "_" && !/[0-9]/.test(src[i - 1] ?? "") ) return null;
        if (src[i] === "_" && !/[0-9]/.test(src[i + 1] ?? "")) return null;
        num += src[i];
        i++;
      }
      // Optional trailing % — "34%" → 0.34. Rejected anywhere else (5%%).
      if (src[i] === "%") {
        percent = true;
        i++;
      }
      if (num.split(".").length > 2 || num.endsWith(".") || num.startsWith(".") || num.includes("__")) return null;
      const parsed = parseFloat(num.replace(/_/g, ""));
      if (!Number.isFinite(parsed)) return null;
      toks.push({ kind: "num", value: percent ? parsed / 100 : parsed });
      continue;
    }
    // Any letter, comma, or other glyph: not arithmetic. Fail closed.
    return null;
  }
  return toks;
}

// ── recursive-descent parser ───────────────────────────────────────────────
class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private eat(): Tok {
    const t = this.toks[this.pos]!;
    this.pos++;
    return t;
  }

  // expr := term (("+" | "-") term)*  — NO end-of-input check: this is also
  // the body of a parenthesized group, where trailing input is the rest of
  // the formula and is none of expr's business.
  private expr(): number {
    let left = this.term();
    while (this.peek()?.kind === "op" && ((this.peek() as { value: Op }).value === "+" || (this.peek() as { value: Op }).value === "-")) {
      const op = this.eat().value as Op;
      const right = this.term();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  // Top level only: the whole token stream must be consumed.
  parse(): number {
    const v = this.expr();
    if (this.pos !== this.toks.length) throw new Error("unexpected trailing input");
    return v;
  }

  // term := factor (("*" | "/" | "%") factor)*
  private term(): number {
    let left = this.factor();
    while (
      this.peek()?.kind === "op" &&
      ((this.peek() as { value: Op }).value === "*" || (this.peek() as { value: Op }).value === "/" || (this.peek() as { value: Op }).value === "%")
    ) {
      const op = this.eat().value as Op;
      const right = this.factor();
      left = op === "*" ? left * right : op === "/" ? left / right : left % right;
    }
    return left;
  }

  // factor := unary ("^" factor)?   — right-associative: 2^3^2 = 2^9
  private factor(): number {
    const base = this.unary();
    if (this.peek()?.kind === "op" && (this.peek() as { value: Op }).value === "^") {
      this.eat();
      const exp = this.factor();
      return Math.pow(base, exp);
    }
    return base;
  }

  // unary := "-" unary | primary
  private unary(): number {
    if (this.peek()?.kind === "op" && (this.peek() as { value: Op }).value === "-") {
      this.eat();
      return -this.unary();
    }
    return this.primary();
  }

  // primary := number | "(" expr ")"
  private primary(): number {
    const t = this.peek();
    if (!t) throw new Error("unexpected end of expression");
    if (t.kind === "num") return this.eat().value as number;
    if (t.kind === "lparen") {
      this.eat();
      const v = this.expr();
      if (this.peek()?.kind !== "rparen") throw new Error("missing closing parenthesis");
      this.eat();
      return v;
    }
    throw new Error("expected a number or parenthesis");
  }
}

// Public for tests: evaluates or returns null when the input isn't arithmetic.
export function evaluateArithmetic(src: string): number | null {
  const toks = tokenize(src);
  if (!toks || toks.length === 0) return null;
  try {
    const result = new Parser(toks).parse();
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function format(n: number): string {
  // Round display to 6 decimals to avoid 0.1+0.2 floating noise in the reply;
  // the exact float rides along for anyone who needs more.
  const rounded = Math.round(n * 1e6) / 1e6;
  return `${rounded.toLocaleString("en-US", { maximumFractionDigits: 6 })} (exactly ${n})`;
}

export const calcTools: EveTool[] = [
  {
    name: "calc",
    description:
      "Evaluate pure arithmetic — numbers, + - * / % ^, parentheses, percentages (34% works as 0.34), underscores as digit separators (1_000_000). No variables, no functions, nothing but arithmetic. Use it to CHECK any non-trivial math before you say it: margins, unit economics, date arithmetic you've already turned into numbers, totals across a ledger query. Your head is for setting the problem up; this is for making the number right.",
    schema: z.object({
      expression: z.string().min(1).max(500).describe("The arithmetic expression, e.g. '(3100 + 5000) / (0.34 - 0.08)'"),
    }),
    needsConfirmation: false,
    run: async (input: Record<string, unknown>): Promise<string> => {
      const src = String(input.expression ?? "");
      const result = evaluateArithmetic(src);
      if (result === null) {
        // Say what IS accepted so the model self-corrects in one hop.
        return `"${src}" isn't pure arithmetic — only numbers, + - * / % ^, parentheses, and trailing percentages. No letters, no functions, no commas.`;
      }
      return `${src} = ${format(result)}`;
    },
  },
];
