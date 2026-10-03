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

function run(entry: string, files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-xfile-")));
  try {
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    const r = spawnSync(process.execPath, ["--import", loader, cli, "--backend=dafny", "gen", entry], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    let out = "";
    try { out = readFileSync(join(dir, entry.replace(/\.ts$/, ".dfy.gen")), "utf8"); } catch { /* failed */ }
    return { status: r.status ?? 1, stderr: r.stderr ?? "", out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A module can declare a value and a type under the *same name* — `const T` with
// `type T = (typeof T)[keyof typeof T]` is the mainstream way to write a string
// union. Imported, the symbol carries two declarations, and the const comes
// first. Taking `declarations[0]` therefore missed the type alias and fell
// through to the record branch, where a string-literal union's *common*
// properties are String.prototype's (toString, charAt, …). Result: a boolean
// union type became a 52-field record and the file grew 51 opaque types named
// after String.prototype — which then crashed the verifier.
test("an imported same-name const+type stays a string union", posixOnly, () => {
  const { status, stderr, out } = run("use.ts", {
    "k.ts": `export const TaskType = { A: 'A_TYPE', B: 'B_TYPE' } as const
export type TaskType = (typeof TaskType)[keyof typeof TaskType]
`,
    "use.ts": `import { TaskType } from './k'
//@ verify
export function pick(t: TaskType): string {
  //@ ensures \\result === \\result
  return t
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out, /datatype TaskType = A_TYPE \| B_TYPE/);
  assert.equal(/^\s*type (toString|charAt|charCodeAt|lastIndexOf)\(==\)/m.test(out), false,
    "String.prototype members must never be emitted as type declarations");
});

// The same shape declared in the entry file was always fine; keep it that way.
test("a same-file same-name const+type stays a string union", posixOnly, () => {
  const { status, stderr, out } = run("same.ts", {
    "same.ts": `export const TaskType = { A: 'A_TYPE', B: 'B_TYPE' } as const
export type TaskType = (typeof TaskType)[keyof typeof TaskType]
//@ verify
export function pick(t: TaskType): string {
  //@ ensures \\result === \\result
  return t
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out, /datatype TaskType = A_TYPE \| B_TYPE/);
});

// Must stay quiet: an imported *interface* is still a record, and its fields
// must still be extracted.
test("an imported interface is still extracted as a record", posixOnly, () => {
  const { status, stderr, out } = run("use.ts", {
    "types.ts": `export interface Payer { userId: string; amount: number }
`,
    "use.ts": `import type { Payer } from './types'
//@ verify
export function amountOf(p: Payer): number {
  //@ ensures \\result === p.amount
  return p.amount
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out, /datatype Payer = Payer\(/);
  assert.match(out, /p\.amount/);
});
