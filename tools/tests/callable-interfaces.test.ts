import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";

function extract(source: string) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true, target: ScriptTarget.ESNext } });
  return extractModule(project.createSourceFile("input.ts", source));
}

test("callable interfaces use the instantiated signature, including imports and inheritance", () => {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
  project.createSourceFile("predicate.ts", `export interface Predicate<in T> { (x:T):boolean }`);
  const file = project.createSourceFile("input.ts", `
    import type { Predicate } from "./predicate";
    interface Strings extends Predicate<string> {}
    export function invert(self:Strings):Predicate<string> { return x => !self(x); }
  `);
  const fn = resolveModule(extractModule(file)).functions[0];
  const predicate = { kind: "fn", params: [{ kind: "string" }], result: { kind: "bool" } };
  assert.deepEqual(fn.params[0].ty, predicate);
  assert.deepEqual(fn.returnTy, predicate);
});

for (const [label, shape] of [
  ["overloads", "(x:number):boolean; (x:string):boolean"],
  ["generic calls", "<T>(x:T):boolean"],
  ["properties", "(x:number):boolean; readonly label:string"],
  ["optional arguments", "(x?:number):boolean"],
  ["rest arguments", "(...xs:number[]):boolean"],
  ["this arguments", "(this:{value:number}, x:number):boolean"],
  ["constructors", "(x:number):boolean; new():object"],
  ["index signatures", "(x:number):boolean; [key:string]:unknown"],
] as const) {
  test(`callable interface extraction does not erase ${label}`, () => {
    const raw = extract(`interface Callable { ${shape} } export function keep(f:Callable):Callable { return f; }`);
    assert.equal(raw.functions[0].params[0].tsType, "Callable");
    assert.equal(raw.functions[0].returnType, "Callable");
  });
}

test("recursive callable interfaces fail explicitly, including through arrays", () => {
  for (const result of ["Recursive", "Recursive[]"]) {
    assert.throws(() => extract(`interface Recursive { (): ${result} } export function keep(f:Recursive):Recursive { return f; }`), /Recursive callable interfaces/);
  }
});

const dafny = spawnSync(process.env.DAFNY_EXE || "dafny", ["--version"], { encoding: "utf8", timeout: 10_000 });
const installed = !dafny.error && dafny.status === 0;
if (process.env.LSC_REQUIRE_DAFNY && !installed) throw new Error("Callable interface integration tests require Dafny");
const loader = createRequire(import.meta.url).resolve("tsx");
const cli = fileURLToPath(new URL("../src/lsc.ts", import.meta.url));
const closures = String.raw`
  interface Predicate<in A> { (value:A):boolean }
  export function negate<A>(self:Predicate<A>):Predicate<A> {
    //@ ensures forall(value: A, \result(value) === !self(value))
    return value => !self(value);
  }
  export function adder(_callee:number):(value:number)=>number {
    //@ ensures forall(value: int, \result(value) === value + _callee)
    return value => value + _callee;
  }
`;
for (const broken of [false, true]) {
  test(`Dafny returned-function contracts ${broken ? "reject a wrong closure" : "verify with a colliding source name"}`, { skip: !installed, timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "lsc-callable-"));
    try {
      const source = join(dir, "closures.ts");
      writeFileSync(source, broken ? closures.replace("return value => !self(value)", "return value => self(value)") : closures);
      const result = spawnSync(process.execPath, ["--import", loader, cli, "check", "--backend=dafny", source], { cwd: dir, encoding: "utf8", timeout: 25_000 });
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      assert.equal(result.status, broken ? 1 : 0, output);
      assert.match(output, broken ? /a postcondition could not be proved/ : /0 errors/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
