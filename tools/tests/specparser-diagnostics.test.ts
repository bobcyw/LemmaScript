import { test } from "node:test";
import assert from "node:assert/strict";

import { parseExpr } from "../src/specparser.ts";

/** A reader of `//@ ` annotations sees these messages at the CLI, so they must
 *  name the offending text and where it is — never an internal token record. */
function messageFor(spec: string): string {
  try {
    parseExpr(spec);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`expected ${JSON.stringify(spec)} to be rejected`);
}

test("postfix ! is reported as such, with offset and a way out", () => {
  const message = messageFor("metadata!.adVideoId === \\result");
  assert.doesNotMatch(message, /\{"type"/, "must not print the internal token record");
  assert.match(message, /Unsupported operator '!' at offset 8/);
  assert.match(message, /non-null assertion/);
  assert.match(message, /requires/);
});

test("optional chaining in a spec is reported as such", () => {
  const message = messageFor("\\result === metadata?.adVideoId");
  assert.doesNotMatch(message, /\{"type"/);
  assert.match(message, /Optional chaining/);
  assert.match(message, /offset/);
});

test("a missing parenthesis says what was expected and what arrived", () => {
  const message = messageFor("(x > 0");
  assert.doesNotMatch(message, /\{"type"/);
  assert.match(message, /Expected punc '\)' here, got the end of the expression/);
  assert.match(message, /\(x > 0/);
});

test("an unsupported character still carries its offset", () => {
  const message = messageFor("x # y");
  assert.match(message, /Unexpected '#' at 2/);
});

test("prefix ! keeps parsing (only the postfix form is rejected)", () => {
  assert.deepEqual(parseExpr("!x"), { kind: "unop", op: "!", expr: { kind: "var", name: "x" } });
});
