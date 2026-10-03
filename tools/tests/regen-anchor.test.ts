import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/lsc.ts", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const posixOnly = { skip: process.platform === "win32" };

const SOURCE = (extraRequires = false, ensures = true) => `type Status = 'A' | 'B'
//@ verify
export function ok(s: Status): boolean {
${extraRequires ? "  //@ requires s === s\n" : ""}${ensures ? '  //@ ensures \\result === (s === "A")\n' : ""}  return s === 'A'
}
`;

function inDir<T>(files: Record<string, string>, fn: (dir: string, run: (args: string[]) => { status: number; stderr: string; stdout: string }) => T): T {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-regen-")));
  try {
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    const run = (args: string[]) => {
      const r = spawnSync(process.execPath, ["--import", loader, cli, ...args], { cwd: dir, encoding: "utf8", timeout: 120_000 });
      return { status: r.status ?? -1, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
    };
    return fn(dir, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The natural flow is: edit the TS → `check` says the artifact is stale → `regen`.
// `check` overwrites `.dfy.gen` on its way, so `regen` used to fall back to a
// generation the proof was *not* built from, read the proof's old generated line
// as a hand edit, and refuse — blaming the user for editing generated text. The
// anchor recorded by a passing check is what makes this flow work.
test("regen survives a preceding failed check", posixOnly, () => {
  inDir({ "f.ts": SOURCE() }, (dir, run) => {
    assert.equal(run(["--backend=dafny", "check", "f.ts"]).status, 0);
    // A hand-written addition, the way a real proof file has one.
    const dfy = readFileSync(join(dir, "f.dfy"), "utf8");
    writeFileSync(join(dir, "f.dfy"), dfy.replace("{\n}", "{\n  // 手写证明追加\n}", 1));
    assert.equal(run(["--backend=dafny", "check", "f.ts"]).status, 0);

    // Now the source changes so a generated line changes too.
    writeFileSync(join(dir, "f.ts"), SOURCE(true));
    const stale = run(["--backend=dafny", "check", "f.ts"]);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /does not match .*\.dfy\.gen/);

    const regen = run(["--backend=dafny", "regen", "f.ts"]);
    assert.equal(regen.status, 0, regen.stdout + regen.stderr);
    const after = readFileSync(join(dir, "f.dfy"), "utf8");
    assert.match(after, /手写证明追加/, "the hand-written addition must survive");
    assert.match(after, /requires \(s == s\)/, "the new generated line must land");
    assert.equal(existsSync(join(dir, "f.dfy.base")), false, "a clean regen clears the anchor");
  });
});

// A spec deleted at the source keeps its old generated lemma in the proof file,
// and the additions-only gate reads that as a hand-written addition. The
// verifier then judges the OLD spec and reports "a postcondition could not be
// proved" — which reads as "the implementation broke". Name the real cause.
test("a spec removed at the source is reported, not judged", posixOnly, () => {
  inDir({ "f.ts": SOURCE() }, (dir, run) => {
    assert.equal(run(["--backend=dafny", "check", "f.ts"]).status, 0);
    writeFileSync(join(dir, "f.ts"), SOURCE(false, false));
    const r = run(["--backend=dafny", "check", "f.ts"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /generated line\(s\) that the current source no longer produces/);
    assert.match(r.stderr, /NOT a failed proof/);
    assert.equal(/postcondition could not be proved/.test(r.stderr), false,
      "the verifier must not run on a stale specification");
  });
});
