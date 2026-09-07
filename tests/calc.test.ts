// The calculator's guard rails: every rejection below was chosen on purpose,
// and the accepted forms are the ones EVE's business math actually needs.
// A parser bug here silently corrupts every number she checks — so the tests
// pin the grammar, the percent sugar, and the fail-closed behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateArithmetic } from "../src/tools/calc.js";

test("plain arithmetic and precedence", () => {
  assert.equal(evaluateArithmetic("2 + 3 * 4"), 14);
  assert.equal(evaluateArithmetic("(2 + 3) * 4"), 20);
  assert.equal(evaluateArithmetic("10 - 4 - 3"), 3); // left assoc
  assert.equal(evaluateArithmetic("2 ^ 3 ^ 2"), 512); // right assoc
  assert.equal(evaluateArithmetic("-5 + 3"), -2);
  assert.equal(evaluateArithmetic("2 * -3"), -6);
});

test("percent sugar: 34% is 0.34, and only trailing", () => {
  assert.equal(evaluateArithmetic("34%"), 0.34);
  assert.equal(evaluateArithmetic("34% * 100"), 34);
  // The business-math shape from the reasoning exam: 8100 / 0.26
  assert.equal(evaluateArithmetic("(3100 + 5000) / (34% - 8%)"), 31153.846153846152);
  assert.equal(evaluateArithmetic("5%%"), null); // double percent is a typo, not 0.0005
  assert.equal(evaluateArithmetic("%5"), null);
});

test("underscores separate digits, between digits only", () => {
  assert.equal(evaluateArithmetic("1_000_000 + 1"), 1000001);
  assert.equal(evaluateArithmetic("_1000"), null);
  assert.equal(evaluateArithmetic("1000_"), null);
  assert.equal(evaluateArithmetic("1__0"), null);
});

test("fail closed: anything non-arithmetic is rejected, never guessed", () => {
  assert.equal(evaluateArithmetic(""), null);
  assert.equal(evaluateArithmetic("2 +"), null);
  assert.equal(evaluateArithmetic("(2 + 3"), null);
  assert.equal(evaluateArithmetic("rm -rf /"), null); // letters are not arithmetic
  assert.equal(evaluateArithmetic("process.exit(1)"), null);
  assert.equal(evaluateArithmetic("2;3"), null); // no statement separator
  assert.equal(evaluateArithmetic("Math.pow(2,3)"), null);
  assert.equal(evaluateArithmetic("1,5"), null); // locale comma — use the dot
  assert.equal(evaluateArithmetic("2 # comment"), null);
});

test("modulo and division behave like the shell's, without the shell", () => {
  assert.equal(evaluateArithmetic("10 % 3"), 1);
  assert.equal(evaluateArithmetic("7 / 2"), 3.5);
  assert.equal(evaluateArithmetic("0.1 + 0.2"), 0.30000000000000004); // exact float rides along; display rounds
});

test("whitespace is free", () => {
  assert.equal(evaluateArithmetic("  2+2  "), 4);
  assert.equal(evaluateArithmetic("2 +\n3"), 5);
});
