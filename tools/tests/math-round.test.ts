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

function run(files: Record<string, string>, args: string[], outputs: string[]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-numeric-")));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const result = spawnSync(process.execPath, ["--import", loader, cli, "--backend=dafny", ...args], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    const out: Record<string, string> = {};
    for (const name of outputs) out[name] = readFileSync(join(dir, name), "utf8");
    return { ...result, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `Math.round` is the money-domain blocker: tax and amount maths round a
// quotient, and JS rounds halves toward +∞ (Math.round(2.5) === 3,
// Math.round(-2.5) === -2) — `floor(x + 0.5)`, not truncation.

test("Math.round of a quotient emits floor(x + 0.5), not integer division", posixOnly, () => {
  const result = run({
    "a.ts": `//@ verify
export function calculateTaxAmount(amountCents: number, taxRateBps: number): number {
  //@ requires amountCents >= 0
  //@ ensures \\result >= 0
  return Math.round((amountCents * taxRateBps) / 10000)
}
`,
  }, ["gen", "a.ts"], ["a.dfy.gen"]);
  assert.equal(result.status, 0, result.stderr);
  const gen = result.out["a.dfy.gen"];
  assert.match(gen, /FloorReal\(/);
  assert.match(gen, /\+ 0\.5\)/);
  // The half-up rule is the whole point: truncating division would be wrong.
  assert.doesNotMatch(gen, /JSFloorDiv\(/);
});

test("Math.round of an integer argument stays integer arithmetic", posixOnly, () => {
  const result = run({
    "a.ts": `//@ verify
export function f(x: number): number {
  //@ ensures \\result === x
  return Math.round(x)
}
`,
  }, ["gen", "a.ts"], ["a.dfy.gen"]);
  assert.equal(result.status, 0, result.stderr);
  const gen = result.out["a.dfy.gen"];
  assert.doesNotMatch(gen, /FloorReal/, "an integer is already rounded; no real round-trip");
});
