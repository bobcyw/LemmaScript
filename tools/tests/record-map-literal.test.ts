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

function generate(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-recmap-")));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const out: Record<string, string> = {};
    let status = 0;
    let stderr = "";
    for (const name of Object.keys(files)) {
      const result = spawnSync(process.execPath, ["--import", loader, cli, "--backend=dafny", "gen", name], {
        cwd: dir, encoding: "utf8", timeout: 60_000,
      });
      if (result.status !== 0) { status = result.status ?? 1; stderr += result.stderr; }
      out[name.replace(/\.ts$/, ".dfy.gen")] = readFileSync(join(dir, name.replace(/\.ts$/, ".dfy.gen")), "utf8");
    }
    return { status, stderr, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STATUS = `type Status = 'QUEUED' | 'RUNNING' | 'DONE'\n`;

// A map-typed literal is a map, not a structure: its keys are values of the
// declared key type. Emitting the field name as a string contradicts a declared
// `map<Status, V>`, and leaving a *local* literal alone degraded it to a tuple —
// a wrong program that still generated (rc=0) and only failed at verification.
test("a local Record<Union, V> literal becomes a map with constructor keys", posixOnly, () => {
  const { status, stderr, out } = generate({
    "a.ts": STATUS + `//@ verify
export function isAllowed(s: Status): boolean {
  //@ ensures \\result === \\result
  const m: Record<Status, boolean> = { QUEUED: true, RUNNING: true, DONE: false }
  if (!(s in m)) return false
  return m[s]
}
`,
  });
  assert.equal(status, 0, stderr);
  const gen = out["a.dfy.gen"];
  assert.match(gen, /map\[Status\.QUEUED :=/);
  assert.doesNotMatch(gen, /\(true, true, false\)/, "a Record literal must not degrade to a tuple");
  assert.doesNotMatch(gen, /map\["QUEUED" :=/, "the key is the variant, not a string");
});

test("a module-level Record<Union, V> const agrees with its declared type", posixOnly, () => {
  const { status, stderr, out } = generate({
    "b.ts": STATUS + `const WEIGHT: Record<Status, number> = { QUEUED: 1, RUNNING: 2, DONE: 3 }
//@ verify
export function weight(s: Status): number {
  //@ ensures \\result >= 1
  if (!(s in WEIGHT)) return 2
  return WEIGHT[s]
}
`,
  });
  assert.equal(status, 0, stderr);
  const gen = out["b.dfy.gen"];
  assert.match(gen, /: map<Status, int> := map\[Status\.QUEUED := 1/);
});

// The other half: string-keyed maps and ordinary structures must be untouched.
test("a Record<string, V> literal keeps string keys", posixOnly, () => {
  const { status, stderr, out } = generate({
    "c.ts": `//@ verify
export function pick(m: Record<string, number>): number {
  //@ ensures \\result >= 0
  if (!("a" in m)) return 0
  return m["a"]
}
//@ verify
export function build(): number {
  //@ ensures \\result >= 0
  const m: Record<string, number> = { a: 1, b: 2 }
  if (!("a" in m)) return 0
  return m["a"]
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out["c.dfy.gen"], /map\["a" := 1/);
});

test("an interface-typed object literal is still a structure", posixOnly, () => {
  const { status, stderr, out } = generate({
    "d.ts": `interface Payer { userId: string }
//@ verify
export function mk(): Payer {
  //@ ensures \\result.userId === "u1"
  return { userId: "u1" }
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.doesNotMatch(out["d.dfy.gen"], /map\[/, "a declared record type must not become a map");
  assert.match(out["d.dfy.gen"], /Payer\("u1"\)/);
});
