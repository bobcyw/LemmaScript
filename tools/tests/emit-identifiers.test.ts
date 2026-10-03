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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-ident-")));
  try {
    writeFileSync(join(dir, name), text);
    const r = spawnSync(process.execPath, ["--import", loader, cli, "--backend=dafny", "gen", name], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    const genPath = join(dir, name.replace(/\.ts$/, ".dfy.gen"));
    let out = "";
    try { out = readFileSync(genPath, "utf8"); } catch { /* generation failed: no file */ }
    return { status: r.status ?? 1, stderr: r.stderr, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Names reach the emitter from two directions that are not Dafny identifiers:
// union variants that are not identifiers at all (`360p`, `a@b`) and
// transpiler-ish temporaries containing `@`. Emitting either as-is yields text
// Dafny cannot parse, and used to exit 0 anyway — invalid output reported as a
// successful generation is the same false green as a wrong program.
test("a union variant that starts with a digit is emitted as a legal name", posixOnly, () => {
  const { status, stderr, out } = gen("a.ts", `type ResolutionPreset = '360p' | '540p' | '720p'
//@ verify
export function isHd(p: ResolutionPreset): boolean {
  //@ ensures \\result === (p === "720p")
  return p === '720p'
}
`);
  assert.equal(status, 0, stderr);
  // Declared and referenced through the same mangled name.
  assert.match(out, /datatype ResolutionPreset = i360p \| i540p \| i720p/);
  assert.match(out, /p\.i720p\?/);
  assert.doesNotMatch(out, /[^A-Za-z0-9_'](360p|540p|720p)/);
});

test("a name containing '@' is emitted as a legal name", posixOnly, () => {
  const { status, stderr, out } = gen("b.ts", `type Marker = 'a@b' | 'plain'
//@ verify
export function isAt(m: Marker): boolean {
  //@ ensures \\result === (m === "a@b")
  return m === 'a@b'
}
`);
  assert.equal(status, 0, stderr);
  assert.match(out, /datatype Marker = a_b \| plain/);
  assert.match(out, /m\.a_b\?/);
  assert.equal(out.includes("@"), false, "no '@' may survive into Dafny");
});

// The other half: a rendered type expression has no name to declare, and the
// fix is in the TypeScript. Refuse loudly instead of emitting `type { … }`.
test("an inline object type is refused, not emitted as `type { … }`", posixOnly, () => {
  const { status, stderr, out } = gen("c.ts", `//@ verify
export function pick(o: { a: string } | null): string | null {
  //@ ensures \\result === null || \\result === \\result
  return o === null ? null : o.a
}
`);
  assert.notEqual(status, 0, "generation of an unparseable declaration must not exit 0");
  assert.match(stderr, /Cannot emit a Dafny type named '\{ a: string \}'/);
  assert.match(stderr, /Name it in the TypeScript/);
  assert.equal(out.includes("type {"), false);
});

test("ordinary names keep their spelling", posixOnly, () => {
  const { status, stderr, out } = gen("d.ts", `type Status = 'QUEUED' | 'RUNNING'
//@ verify
export function isRunning(s: Status): boolean {
  //@ ensures \\result === (s === "RUNNING")
  return s === 'RUNNING'
}
`);
  assert.equal(status, 0, stderr);
  assert.match(out, /datatype Status = QUEUED \| RUNNING/);
  assert.match(out, /s\.RUNNING\?/);
});
