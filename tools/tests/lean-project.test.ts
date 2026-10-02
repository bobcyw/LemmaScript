import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { findLakeProjectRoot, leanCheck } from "../src/lean-commands.ts";

function fixture(run: (root: string, source: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "lemmascript-lake project-"));
  const source = path.join(root, "src", "nested space");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "example.proof.lean"), "-- fixture\n");
    run(root, source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const marker of ["lakefile.lean", "lakefile.toml"]) {
  test(`discovers ${marker} from a nested directory`, () => fixture((root, source) => {
    writeFileSync(path.join(root, marker), "-- marker\n");
    assert.equal(findLakeProjectRoot(source), root);
  }));
  test(`discovers ${marker} in the source directory itself`, () => fixture((_root, source) => {
    writeFileSync(path.join(source, marker), "-- marker\n");
    assert.equal(findLakeProjectRoot(source), source);
  }));
}

for (const [outer, inner] of [
  ["lakefile.lean", "lakefile.toml"],
  ["lakefile.toml", "lakefile.lean"],
]) {
  test(`nearest ${inner} wins over outer ${outer}`, () => fixture((root, source) => {
    writeFileSync(path.join(root, outer), "-- outer\n");
    const nearest = path.dirname(source);
    writeFileSync(path.join(nearest, inner), "-- inner\n");
    assert.equal(findLakeProjectRoot(source), nearest);
  }));
}

test("both markers in one directory identify the same project", () => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.lean"), "-- marker\n");
  writeFileSync(path.join(root, "lakefile.toml"), "-- marker\n");
  assert.equal(findLakeProjectRoot(source), root);
}));

test("relative source paths are resolved before searching", () => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.toml"), "-- marker\n");
  assert.equal(findLakeProjectRoot(path.relative(process.cwd(), source)), root);
}));

for (const marker of ["lakefile.lean", "lakefile.toml"]) {
  test(`checks the filesystem root for ${marker}`, (t) => {
    const root = path.parse(process.cwd()).root;
    t.mock.method(fs, "existsSync", (p: fs.PathLike) => String(p) === path.join(root, marker));
    syncBuiltinESMExports();
    try {
      assert.equal(findLakeProjectRoot(path.join(root, "virtual", "nested")), root);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

test("no marker returns null and leanCheck does not spawn Lake", (t) => {
  t.mock.method(fs, "existsSync", (p: fs.PathLike) => String(p).endsWith("example.proof.lean"));
  const spawn = t.mock.method(childProcess, "execFileSync", () => { throw new Error("must not spawn"); });
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => { errors.push(message); });
  syncBuiltinESMExports();
  try {
    assert.equal(findLakeProjectRoot("virtual/source"), null);
    assert.equal(leanCheck("virtual/source", "example"), false);
    assert.equal(spawn.mock.callCount(), 0);
    assert.match(errors.join("\n"), /lakefile\.lean or lakefile\.toml/);
    assert.match(errors.join("\n"), /lake was not started/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("missing proof files do not launch Lake", (t) => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.toml"), "-- marker\n");
  const spawn = t.mock.method(childProcess, "execFileSync", () => { throw new Error("must not spawn"); });
  syncBuiltinESMExports();
  try {
    assert.equal(leanCheck(source, "missing"), false);
    assert.equal(spawn.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("launches lake build in the discovered project, preserving paths with spaces", (t) => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.toml"), "-- marker\n");
  const spawn = t.mock.method(childProcess, "execFileSync", () => Buffer.alloc(0));
  syncBuiltinESMExports();
  try {
    assert.equal(leanCheck(source, "example"), true);
    assert.equal(spawn.mock.callCount(), 2);
    assert.deepEqual(spawn.mock.calls[0].arguments, [
      "lake",
      ["build", "«example.proof»"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ]);
    assert.deepEqual(spawn.mock.calls[1].arguments, ["lake", ["build"], { cwd: root, stdio: "inherit" }]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

// An unregistered module compiles nothing under a project-wide `lake build`,
// which still exits 0. Verified in this checkout: `lake build «foo.proof»`
// answers `error: unknown target `foo.proof`` for a module no library reaches.
const unknownTargetError = (name: string) =>
  Object.assign(new Error("lake build failed"), { stdout: `error: unknown target \`${name}\`\n` });

for (const [marker, roots] of [
  ["lakefile.lean", "lean_lib Examples where\n  roots := #[`«other.def», `«other.proof»]\n"],
  ["lakefile.toml", "[[lean_lib]]\nname = \"Examples\"\nroots = [\"Other.def\", \"Other.proof\"]\n"],
] as const) {
  test(`rejects an unregistered module (${marker}) without the project-wide build`, (t) => fixture((root, source) => {
    writeFileSync(path.join(root, marker), roots);
    const spawn = t.mock.method(childProcess, "execFileSync", () => { throw unknownTargetError("example.proof"); });
    const errors: string[] = [];
    t.mock.method(console, "error", (message: string) => { errors.push(message); });
    syncBuiltinESMExports();
    try {
      assert.equal(leanCheck(source, "example"), false);
      assert.equal(spawn.mock.callCount(), 1, "the project-wide build must not run after the registration failure");
      assert.match(errors.join("\n"), /is not registered in the Lake project/);
      assert.match(errors.join("\n"), /roots/);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }));
}

for (const [marker, roots] of [
  ["lakefile.lean", "lean_lib Examples where\n  roots := #[`«example.def», `«example.proof»]\n"],
  ["lakefile.toml", "[[lean_lib]]\nname = \"Examples\"\nroots = [\"example.def\", \"example.proof\"]\n"],
] as const) {
  test(`falls back to the project-wide build when roots list the module (${marker})`, (t) => fixture((root, source) => {
    writeFileSync(path.join(root, marker), roots);
    const spawn = t.mock.method(childProcess, "execFileSync", (_file: string, args: string[]) => {
      if (args.length === 2) throw unknownTargetError("example.proof");
      return Buffer.alloc(0);
    });
    syncBuiltinESMExports();
    try {
      assert.equal(leanCheck(source, "example"), true);
      assert.equal(spawn.mock.callCount(), 2);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }));
}

test("does not judge registration when no roots list is written down", (t) => fixture((root, source) => {
  // Lake treats every module under the library's source directory as a root
  // when `roots` is omitted, so absence of a list is not evidence of absence.
  writeFileSync(path.join(root, "lakefile.lean"), "lean_lib Examples\n");
  const spawn = t.mock.method(childProcess, "execFileSync", (_file: string, args: string[]) => {
    if (args.length === 2) throw unknownTargetError("example.proof");
    return Buffer.alloc(0);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(leanCheck(source, "example"), true);
    assert.equal(spawn.mock.callCount(), 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("an unclear probe failure keeps its output and lets the project-wide build decide", (t) => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.lean"), "lean_lib Examples where\n  roots := #[`«example.proof»]\n");
  const spawn = t.mock.method(childProcess, "execFileSync", (_file: string, args: string[]) => {
    if (args.length === 2) {
      throw Object.assign(new Error("lake build failed"), { stderr: "error: proof did not go through\n" });
    }
    return Buffer.alloc(0);
  });
  const written: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { written.push(String(chunk)); return true; });
  syncBuiltinESMExports();
  try {
    assert.equal(leanCheck(source, "example"), true);
    assert.equal(spawn.mock.callCount(), 2);
    assert.match(written.join(""), /proof did not go through/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("a project-wide build failure returns false", (t) => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.lean"), "lean_lib Examples where\n  roots := #[`«example.proof»]\n");
  const spawn = t.mock.method(childProcess, "execFileSync", () => { throw new Error("lake build failed"); });
  syncBuiltinESMExports();
  try {
    assert.equal(leanCheck(source, "example"), false);
    assert.equal(spawn.mock.callCount(), 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("a missing lake binary is reported, not silently swallowed", (t) => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.lean"), "-- marker\n");
  t.mock.method(childProcess, "execFileSync", () => {
    throw Object.assign(new Error("spawn lake ENOENT"), { code: "ENOENT" });
  });
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => { errors.push(message); });
  syncBuiltinESMExports();
  try {
    assert.equal(leanCheck(source, "example"), false);
    assert.match(errors.join("\n"), /not found on PATH/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

for (const error of [new Error("lake build failed"), Object.assign(new Error("lake not installed"), { code: "ENOENT" })]) {
  test(`${error.message} returns false`, (t) => fixture((root, source) => {
    writeFileSync(path.join(root, "lakefile.lean"), "-- marker\n");
    t.mock.method(childProcess, "execFileSync", () => { throw error; });
    syncBuiltinESMExports();
    try { assert.equal(leanCheck(source, "example"), false); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }));
}
