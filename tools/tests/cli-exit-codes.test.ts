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

function lsc(args: string[], files: Record<string, string> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-exit-")));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const r = spawnSync(process.execPath, ["--import", loader, cli, ...args], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The rule a caller has to be able to rely on: **an error on stderr means a
// non-zero exit**. Without it, a harness that checks `$?` reads "success" from a
// run that produced nothing, and any claim built on that exit code (including
// "the tree is clean", "regeneration succeeded") can be true on a tree where
// nothing happened. Reported by a consumer whose batch harness did exactly that.
// Every failure names itself: a bare stack trace or a silent exit is not a
// diagnosis. `File not found:` and `Usage:` are the CLI's other two shapes.
const ERROR_PREFIXES = /^(ERROR|FAILED|CONFLICT|File not found|Unknown command|Usage)\b/m;

const FAILURES: [string, string[], Record<string, string>][] = [
  ["an unsupported switch case fails extraction", ["--backend=dafny", "gen", "bad.ts"], {
    "bad.ts": `//@ verify
export function pick(x: number): number {
  //@ ensures \\result === \\result
  let r = 0
  switch (x) { case 1: r = 1; break; case x + 1: r = 2; break; default: r = 3 }
  return r
}
`,
  }],
  ["an unnameable type is refused at emission", ["--backend=dafny", "gen", "inline.ts"], {
    "inline.ts": `//@ verify
export function pick(o: { a: string } | null): string | null {
  //@ ensures \\result === null || \\result === \\result
  return o === null ? null : o.a
}
`,
  }],
  ["a missing file", ["--backend=dafny", "gen", "nope.ts"], {}],
  ["an unknown command", ["frobnicate", "any.ts"], {
    "any.ts": `export function id(x: number): number { return x }\n`,
  }],
];

for (const [what, args, files] of FAILURES) {
  test(`rc != 0 when ${what}`, posixOnly, () => {
    const r = lsc(args, files);
    assert.match(r.stderr, ERROR_PREFIXES, `expected an error on stderr, got: ${r.stderr}`);
    assert.notEqual(r.status, 0, `stderr said error but exit was ${r.status}`);
  });
}

test("rc != 0 when verification fails", posixOnly, () => {
  const r = lsc(["--backend=dafny", "check", "false.ts"], {
    "false.ts": `//@ verify
export function bad(x: number): number {
  //@ ensures \\result > x
  return x
}
`,
  });
  assert.notEqual(r.status, 0, "a failing proof must not exit 0");
});

// The positive control that closes the same hole from the other side: exit 0
// must mean the command *did* something. `gen` either generates or explicitly
// skips — never "nothing happened, no error".
test("exit 0 from gen means it generated or explicitly skipped", posixOnly, () => {
  const ok = lsc(["--backend=dafny", "gen", "good.ts"], {
    "good.ts": `//@ verify
export function id(x: number): number {
  //@ ensures \\result === x
  return x
}
`,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Generated:/);

  const skipped = lsc(["--backend=dafny", "gen", "leanonly.ts"], {
    "leanonly.ts": `//@ backend lean
//@ verify
export function id(x: number): number {
  //@ ensures \\result === x
  return x
}
`,
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /Skipped:/, "a skipped file must say so");
  assert.doesNotMatch(skipped.stdout, /Generated:/, "a skipped file generated nothing");
});
