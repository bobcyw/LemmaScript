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

/** Generate both spellings in one temp dir and return their `.dfy.gen` texts. */
function generate(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-record-")));
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
      const gen = name.replace(/\.ts$/, ".dfy.gen");
      out[gen] = readFileSync(join(dir, gen), "utf8");
    }
    return { status, stderr, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BODY = (access: string) => `//@ verify
export function pick(metadata: Record<string, string>): string | null {
  //@ ensures \\result === null || \\result === metadata["adVideoId"]
  if (!("adVideoId" in metadata)) return null
  return ${access}
}
`;

// `Record<string, V>` is stored as a Dafny map, which has no member `key`. The
// member form has to lower to the same thing the index form does — a real
// record lookup, not a projection, and not a reject.
test("a Record member access generates the same Dafny as the index form", posixOnly, () => {
  const { status, stderr, out } = generate({ "dot.ts": BODY("metadata.adVideoId"), "idx.ts": BODY('metadata["adVideoId"]') });
  assert.equal(status, 0, stderr);
  assert.match(out["dot.dfy.gen"], /\["adVideoId"\]/, "the member form must become a map lookup");
  assert.doesNotMatch(out["dot.dfy.gen"], /\.adVideoId/, "no member projection may reach Dafny");
  assert.equal(
    out["dot.dfy.gen"].split("\n").slice(1).join("\n"),
    out["idx.dfy.gen"].split("\n").slice(1).join("\n"),
    "both spellings must lower through the same path",
  );
});

test("an optional Record member access (?.key) lowers the same way", posixOnly, () => {
  const { status, stderr, out } = generate({
    "opt.ts": `//@ verify
export function pick(metadata: Record<string, string> | null): boolean {
  //@ ensures \\result === \\result
  return metadata?.adVideoId === "x"
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out["opt.dfy.gen"], /\["adVideoId"\]/);
  assert.doesNotMatch(out["opt.dfy.gen"], /\.adVideoId/);
});

// The other half: a real record field, and the map intrinsics, must NOT be
// rewritten into lookups.
test("a declared record field stays a member projection", posixOnly, () => {
  const { status, stderr, out } = generate({
    "rec.ts": `interface Payer { userId: string }
//@ verify
export function payerId(p: Payer): string {
  //@ ensures \\result === p.userId
  return p.userId
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out["rec.dfy.gen"], /\.userId/);
  assert.doesNotMatch(out["rec.dfy.gen"], /\["userId"\]/);
});

test("map intrinsics keep their own lowering", posixOnly, () => {
  const { status, stderr, out } = generate({
    "size.ts": `//@ verify
export function count(m: Map<string, string>): number {
  //@ ensures \\result >= 0
  return m.size
}
`,
  });
  assert.equal(status, 0, stderr);
  assert.match(out["size.dfy.gen"], /\|m\|/, "m.size is the map's cardinality, not a lookup of 'size'");
  assert.doesNotMatch(out["size.dfy.gen"], /\["size"\]/);
});
