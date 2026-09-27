import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPTIONS, type LscOptions } from "../src/config.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import type { Decl, Module } from "../src/ir.ts";

const utf16: LscOptions = { ...DEFAULT_OPTIONS, "string-semantics": "javascript-utf16" };
const optionsHeader = /^\/\/ lsc options: string-semantics=javascript-utf16$/m;

function moduleWith(...decls: Decl[]): Module {
  return { comment: "", imports: [], options: [], decls };
}

const numbers = moduleWith({ kind: "const", name: "answer", type: { kind: "int" }, value: { kind: "num", value: 42 } });
const stringType: Decl = { kind: "type-alias", name: "Text", target: { kind: "string" } };

for (const [name, declaration] of [
  ["string type without literals", stringType],
  ["nested string type", { kind: "type-alias", name: "Texts", target: {
    kind: "optional", inner: { kind: "array", elem: { kind: "string" } },
  } }],
  ["string literals without string annotations", { kind: "const", name: "same", type: { kind: "bool" }, value: {
    kind: "binop", op: "==", left: { kind: "str", value: "hello" }, right: { kind: "str", value: "hello" },
  } }],
] satisfies [string, Decl][]) {
  test(`string usage resets between files after ${name}`, () => {
    const baseline = emitDafnyFile(numbers, "numbers.ts", utf16);
    assert.doesNotMatch(baseline, optionsHeader);
    assert.match(emitDafnyFile(moduleWith(declaration), "strings.ts", utf16), optionsHeader);
    assert.equal(emitDafnyFile(numbers, "numbers.ts", utf16), baseline);
  });
}

test("string usage remains set across declarations within one file", () => {
  assert.match(emitDafnyFile(moduleWith(stringType, ...numbers.decls), "mixed.ts", utf16), optionsHeader);
});

test("string profile and literal encoding reset between files", () => {
  const literal = moduleWith({ kind: "const", name: "emoji", type: { kind: "string" }, value: { kind: "str", value: "😀" } });
  const encoded = emitDafnyFile(literal, "literal.ts", utf16);
  assert.match(encoded, optionsHeader);
  assert.ok(encoded.includes('"\\uD83D\\uDE00"'));

  // Omit the options argument so the default must replace the previous profile.
  const scalar = emitDafnyFile(literal, "literal.ts");
  assert.doesNotMatch(scalar, optionsHeader);
  assert.ok(scalar.includes('"😀"'));
  assert.equal(emitDafnyFile(literal, "literal.ts", utf16), encoded);
});

test("string helper preambles do not leak into the next file", () => {
  const baseline = emitDafnyFile(numbers, "numbers.ts", utf16);
  const search = moduleWith({ kind: "const", name: "position", type: { kind: "int" }, value: {
    kind: "methodCall", obj: { kind: "str", value: "hello" }, objTy: { kind: "string" },
    method: "indexOf", args: [{ kind: "str", value: "e" }], monadic: false,
  } });
  const output = emitDafnyFile(search, "search.ts", utf16);
  assert.match(output, optionsHeader);
  assert.match(output, /function StringIndexOf\(/);
  assert.equal(emitDafnyFile(numbers, "numbers.ts", utf16), baseline);
});

for (const inNamespace of [false, true]) {
  test(`string usage resets after failed emission${inNamespace ? " inside a namespace" : ""}`, () => {
    const baseline = emitDafnyFile(numbers, "numbers.ts", utf16);
    const declarations: Decl[] = [stringType, {
      kind: "const", name: "unsupported", type: { kind: "int" }, value: {
        kind: "methodCall", obj: { kind: "str", value: "hello" }, objTy: { kind: "string" },
        method: "unsupported", args: [], monadic: false,
      },
    }];
    const failing = inNamespace
      ? moduleWith({ kind: "namespace", name: "Example", decls: declarations })
      : moduleWith(...declarations);
    assert.throws(() => emitDafnyFile(failing, "unsupported.ts", utf16), /Unsupported Dafny method call/);
    assert.equal(emitDafnyFile(numbers, "numbers.ts", utf16), baseline);
  });
}
