import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/lsc.ts", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const posixOnly = { skip: process.platform === "win32" };

/** Run `lsc <args>` over one source file. `gen` needs no prover. */
function run(source: string, args: string[]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-brownfield-")));
  try {
    writeFileSync(join(dir, "a.ts"), source);
    return spawnSync(process.execPath, ["--import", loader, cli, "--backend=dafny", ...args, "a.ts"], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A module-level singleton is outside the modelled fragment and no proof can
// use it. Failing the whole file for it would make brownfield verification
// impossible on any codebase that exports one (`export const svc = new Svc()`),
// which is what a real repo does everywhere.
const SINGLETON = `class Svc { x = 1; }
const svc = new Svc();
`;

const VERIFIED_PURE = `//@ verify
export function pureFn(n: number): number {
  //@ ensures \\result === n
  return n;
}
`;

test("brownfield: an unmodelled module-level const is skipped, not fatal", posixOnly, () => {
  const result = run(SINGLETON + VERIFIED_PURE, ["gen"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Note: skipped module-level const 'svc' at a\.ts:2 \(Unsupported expression: new Svc\(\)\)/);
});

test("brownfield: the skipped const does not reach the generated program", posixOnly, () => {
  const result = run(SINGLETON + VERIFIED_PURE, ["gen"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /svc/);
});

test("brownfield: a const a verified function refers to stays fatal", posixOnly, () => {
  const result = run(SINGLETON + `//@ verify
export function usesIt(): number {
  //@ ensures \\result === \\result
  return svc.x;
}
`, ["gen"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Failed to extract const 'svc' at a\.ts:2/);
});

test("not brownfield: the same const stays fatal", posixOnly, () => {
  const result = run(SINGLETON + "export function plain(n: number): number { return n; }\n", ["gen"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Failed to extract const 'svc' at a\.ts:2/);
});
