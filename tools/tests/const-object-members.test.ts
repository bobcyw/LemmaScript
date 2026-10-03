import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/lsc.ts", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const posixOnly = { skip: process.platform === "win32" };

function run(name: string, files: Record<string, string>, args = ["--backend=dafny", "gen", name]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-const-")));
  try {
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    const r = spawnSync(process.execPath, ["--import", loader, cli, ...args], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    let out = "";
    try { out = readFileSync(join(dir, name.replace(/\.ts$/, ".dfy.gen")), "utf8"); } catch { /* generation failed */ }
    return { status: r.status ?? 1, stderr: r.stderr ?? "", stdout: r.stdout ?? "", out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `const M = { a: 'a' } as const; type M = (typeof M)[keyof typeof M]` is the
// mainstream way to declare a string union in TS. The *type* was already modeled
// (a string union), but the object is not extracted, so `M.a` used to be emitted
// verbatim — `unresolved identifier: M`, with `gen` exiting 0. It must fold to
// the literal, which the string-union lowering then turns into the constructor.
test("an `as const` member access folds to the union constructor", posixOnly, () => {
  const { status, stderr, out } = run("m.ts", {
    "m.ts": `export const MODES = { fast: 'fast', slow: 'slow' } as const
export type Mode = (typeof MODES)[keyof typeof MODES]
//@ verify
export function isFast(m: Mode): boolean {
  //@ ensures \\result === (m === "fast")
  return m === MODES.fast
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out, /datatype Mode = fast \| slow/);
  assert.match(out, /m\.fast\?/);
  assert.equal(out.includes("MODES"), false, "the object must not survive into Dafny");
});

test("the same fold works through an import", posixOnly, () => {
  const { status, stderr, out } = run("use.ts", {
    "keys.ts": `export const VENDORS = { DEEPSEEK: 'deepseek' } as const
export type Vendor = (typeof VENDORS)[keyof typeof VENDORS]
`,
    "use.ts": `import { VENDORS, type Vendor } from './keys'
//@ verify
export function isDeepSeek(v: Vendor): boolean {
  //@ ensures \\result === (v === "deepseek")
  return v === VENDORS.DEEPSEEK
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out, /v\.deepseek\?/);
  assert.equal(out.includes("VENDORS"), false);
});

// The other half: a mutable `const` object is NOT a compile-time constant (its
// properties can be reassigned), and it is not extracted either — so the access
// could only become another undeclared identifier. Refuse with the fix.
test("a mutable const object member access is refused, not emitted", posixOnly, () => {
  const { status, stderr } = run("p.ts", {
    "p.ts": `export const M = { a: 'a' }
//@ verify
export function isA(s: string): boolean {
  //@ ensures \\result === \\result
  return s === M.a
}
`,
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /Cannot model 'M\.a'/);
  assert.match(stderr, /as const/);
});

// Must stay quiet: a field access on a value of a declared type is a real field
// access and must not be folded, refused, or otherwise disturbed.
test("field access on a declared type is left alone", posixOnly, () => {
  const { status, stderr, out } = run("r.ts", {
    "r.ts": `interface Payer { userId: string; amount: number }
//@ verify
export function amountOf(p: Payer): number {
  //@ ensures \\result === p.amount
  return p.amount
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out, /p\.amount/);
});
