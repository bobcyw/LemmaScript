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

// A `.dfy` left stale by a TS edit fails the additions-only check before the
// verifier runs. The message must say so: in a mutation test that red is easy to
// mistake for "the verifier caught my change".
test("a stale proof file is reported as stale, not as a verification verdict", posixOnly, () => {
  const v1 = `//@ verify
export function f(x: number): number {
  //@ ensures \\result === x
  return x
}
`;
  const v2 = v1.replace("return x\n", "return x + 1\n");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-stale-")));
  try {
    writeFileSync(join(dir, "a.ts"), v1);
    const first = spawnSync(process.execPath, ["--import", loader, cli, "--backend=dafny", "gen", "a.ts"], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(join(dir, "a.ts"), v2);
    const second = spawnSync(process.execPath, ["--import", loader, cli, "--backend=dafny", "check", "a.ts"], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /This is NOT a verification verdict: the verifier has not run/);
    assert.match(second.stderr, /lsc regen/);
    assert.doesNotMatch(second.stderr, /has modifications to generated lines \(not additions-only\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
