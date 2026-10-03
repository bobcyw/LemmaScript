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

function gen(name: string, text: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-union-")));
  try {
    writeFileSync(join(dir, name), text);
    const r = spawnSync(process.execPath, ["--import", loader, cli, "--backend=dafny", "gen", name], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    let out = "";
    try { out = readFileSync(join(dir, name.replace(/\.ts$/, ".dfy.gen")), "utf8"); } catch { /* failed */ }
    return { status: r.status ?? 1, stderr: r.stderr ?? "", out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A member of an `as const` object folds to the string it stands for. Where a
// *string* is expected that is right; where the **union datatype** is expected
// the value must be the variant constructor. A consumer caught the second case
// in a regenerated artifact — `map[Status.PENDING := "PENDING", …]` against a
// declared `map<Status, Status>` — by diffing it against the committed one.
test("a folded member used as a map key or value becomes the variant", posixOnly, () => {
  const { status, stderr, out } = gen("t.ts", `export const Status = { A: 'A', B: 'B' } as const
export type Status = (typeof Status)[keyof typeof Status]
export const OTHER: Record<Status, Status> = { A: Status.B, B: Status.A }
//@ verify
export function same(s: Status): boolean {
  //@ ensures \\result === \\result
  return s in OTHER
}
`);
  assert.equal(status, 0, stderr);
  assert.match(out, /datatype Status = A \| B/);
  const line = out.split("\n").find(l => l.startsWith("const OTHER")) ?? "";
  assert.match(line, /map<Status, Status>/);
  assert.match(line, /Status\.A := Status\.B/);
  assert.match(line, /Status\.B := Status\.A/);
  assert.equal(/"A"|"B"/.test(line), false, "no bare string may stand for a variant here");
});

// Must stay quiet: an ordinary string map keeps string keys and string values.
test("a string-keyed map keeps its literals", posixOnly, () => {
  const { status, stderr, out } = gen("s.ts", `export const LABELS: Record<string, string> = { a: 'x', b: 'y' }
//@ verify
export function n(s: string): boolean {
  //@ ensures \\result === \\result
  return s in LABELS
}
`);
  assert.equal(status, 0, stderr);
  const line = out.split("\n").find(l => l.startsWith("const LABELS")) ?? "";
  assert.match(line, /map<string, string>/);
  assert.match(line, /"a" := "x"/);
  assert.match(line, /"b" := "y"/);
});
