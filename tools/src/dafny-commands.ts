/**
 * Dafny backend commands: gen, check, regen.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { DEFAULT_OPTIONS, parseOptionValue, type LscOptions } from "./config.js";

function writeGen(genPath: string, text: string) {
  writeFileSync(genPath, text);
  console.log(`Generated: ${genPath}`);
}

export function dafnyGen(genPath: string, dfyPath: string, text: string) {
  writeGen(genPath, text);
  if (!existsSync(dfyPath)) {
    writeFileSync(dfyPath, text);
    console.log(`Created: ${dfyPath}`);
  }
}

export function dafnyCheckDiff(genPath: string, dfyPath: string): boolean {
  for (const filePath of [genPath, dfyPath]) {
    if (!existsSync(filePath)) {
      console.error(`ERROR: cannot verify additions-only diff; file does not exist: ${filePath}`);
      return false;
    }
  }

  // Proof additions must retain the model chosen by the generated companion.
  try {
    const generated = readStringSemantics(readFileSync(genPath, "utf-8"));
    const proof = readStringSemantics(readFileSync(dfyPath, "utf-8"));
    if (proof !== generated) {
      throw new Error(`proof string-semantics=${proof} differs from generated string-semantics=${generated}`);
    }
  } catch (error) {
    console.error(`ERROR: ${path.basename(dfyPath)}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  let diff = "";
  try {
    diff = execFileSync(
      "git",
      ["diff", "--no-index", "--minimal", "--no-color", "--no-ext-diff", "--no-textconv", "--text", "--", genPath, dfyPath],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e: any) {
    // `git diff --no-index` exits 1 for a valid, non-empty comparison. Every
    // other exit shape means the comparison did not complete, even when git
    // happened to return partial stdout.
    const status = e?.status;
    const stdout = typeof e?.stdout === "string" ? e.stdout : "";
    if (status !== 1 || e?.signal != null || e?.code != null || !stdout.startsWith("diff --git ")) {
      const detail = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      console.error(
        `ERROR: could not run \`git diff\` to verify ${path.basename(dfyPath)} is additions-only` +
        `${status === undefined ? " (is git installed?)" : ` (git exited ${status})`}` +
        `${detail ? `: ${detail}` : ""}`,
      );
      return false;
    }
    diff = stdout;
  }
  // Only file headers are metadata. Inside a hunk, even a line beginning
  // with "---" is a deletion (for example, text inside a multiline string).
  const deletions: string[] = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && line.startsWith("-")) deletions.push(line);
  }
  if (deletions.length > 0) {
    // Deliberately not phrased as a verification result. A stale `.dfy` (TS body
    // edited without regenerating) lands here too, and reading this as "the
    // verifier rejected my change" would make a mutation test look like it fired
    // when the verifier never ran.
    console.error(`ERROR: ${path.basename(dfyPath)} does not match ${path.basename(genPath)} — generated lines were`);
    console.error("modified, or the proof file is stale. This is NOT a verification verdict: the verifier has not run.");
    console.error("  - Changed the .ts? Use `lsc regen` — it merges and keeps your proof additions.");
    console.error("  - Edited generated text by hand? Undo it: generated lines belong to the tool, not the proof.");
    console.error("Offending lines:");
    for (const d of deletions.slice(0, 5)) console.error("  " + d);
    return false;
  }
  return true;
}

/** Read the saved model, rejecting ambiguous headers before verification. */
function readStringSemantics(content: string): LscOptions["string-semantics"] {
  const headers = [...content.matchAll(/^\/\/ lsc options:(.*)$/gm)];
  if (headers.length > 1) throw new Error("generated header: duplicate lsc options header (string-semantics must be unambiguous)");
  let model = DEFAULT_OPTIONS["string-semantics"];
  let seen = false;
  for (const token of (headers[0]?.[1] ?? "").trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    const key = eq < 0 ? token : token.slice(0, eq);
    if (key !== "string-semantics") continue;
    if (seen) throw new Error("generated header: duplicate string-semantics option");
    seen = true;
    model = parseOptionValue(key, eq < 0 ? "" : token.slice(eq + 1), "generated header");
  }
  return model;
}

/**
 * Build verifier arguments from the generated file's `// lsc options:` header.
 * Reading the saved string model instead of the current project config keeps
 * verification consistent with generation, even if the config later changes.
 * Always pass `--unicode-char` explicitly. UTF-16 mode also needs
 * `--allow-deprecation` because Dafny 4.11 deprecates `--unicode-char:false`.
 * Other warning categories remain fatal.
 */
export function dafnyVerifyArgs(content: string, timeLimit?: number, extraFlags?: string): { args: string[]; error?: string } {
  let stringSemantics: LscOptions["string-semantics"];
  try {
    stringSemantics = readStringSemantics(content);
  } catch (error) {
    return { args: [], error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
  }
  const utf16 = stringSemantics === "javascript-utf16";
  const usesStandardLibrary = content.includes("Std.");
  if (utf16 && usesStandardLibrary) {
    return { args: [], error:
      "ERROR: this proof combines \"string-semantics\": \"javascript-utf16\" with Dafny's standard library. " +
      "Dafny 4.11 cannot load its Unicode-scalar standard library under --unicode-char:false. " +
      "Set \"dafny-library\": \"local\" in lemmascript.json or add //@ option dafny-library local, " +
      "then run lsc regen to regenerate collection helpers. " +
      "This does not rewrite handwritten Std.* imports or calls; replace those with local proofs or helpers separately." };
  }
  const args: string[] = ["verify"];
  if (usesStandardLibrary) args.push("--standard-libraries");
  if (timeLimit) args.push("--verification-time-limit", String(timeLimit));
  if (extraFlags) {
    for (const tok of extraFlags.split(/\s+/)) if (tok) args.push(tok);
  }
  args.push(utf16 ? "--unicode-char:false" : "--unicode-char:true");
  if (utf16) args.push("--allow-deprecation");
  return { args };
}

export function dafnyVerify(dfyPath: string, dir: string, timeLimit?: number, extraFlags?: string): boolean {
  console.log("Running dafny verify...");
  try {
    const { args, error } = dafnyVerifyArgs(readFileSync(dfyPath, "utf-8"), timeLimit, extraFlags);
    if (error) { console.error(error); return false; }
    args.push(dfyPath);
    execFileSync("dafny", args, { cwd: dir, stdio: "inherit" });
    return true;
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      console.error("ERROR: `dafny` not found on PATH — verification never ran. Install Dafny 4.x: https://dafny.org/");
    }
    return false;
  }
}

export function dafnyRegen(genPath: string, dfyPath: string, basePath: string, text: string, dir: string, timeLimit?: number, extraFlags?: string, noVerify = false) {
  // 1. Read old gen before overwriting (needed for base seeding)
  const oldGen = existsSync(genPath) ? readFileSync(genPath, "utf-8") : "";

  // 2. Always write new gen so user can inspect latest output
  writeGen(genPath, text);

  // 3. No .dfy yet — create dfy, verify, done
  if (!existsSync(dfyPath)) {
    writeFileSync(dfyPath, text);
    console.log(`Created: ${path.basename(dfyPath)}`);
    if (!noVerify && !dafnyVerify(dfyPath, dir, timeLimit, extraFlags)) {
      console.error(`FAILED: ${path.basename(dfyPath)} verification failed on first run.`);
      process.exit(1);
    }
    return;
  }

  // 4. Determine anchor: base file if it exists (dirty state), otherwise old gen
  const anchor = existsSync(basePath) ? readFileSync(basePath, "utf-8") : oldGen;

  // 5. If gen changed, three-way merge
  if (text !== anchor) {
    const savedDfy = readFileSync(dfyPath, "utf-8");
    if (!existsSync(basePath)) writeFileSync(basePath, anchor);
    const mergedPath = dfyPath + ".merged";
    console.log("Gen changed. Three-way merging...");
    try {
      execFileSync("git", ["merge-file", dfyPath, basePath, genPath], { stdio: "pipe" });
      console.log(`Merged: ${path.basename(dfyPath)}`);
    } catch (e: any) {
      if (e.status > 0) {
        copyFileSync(dfyPath, mergedPath);
        writeFileSync(dfyPath, savedDfy);
        console.error(`CONFLICT: ${path.basename(dfyPath)} — merge had conflicts, dfy restored. See ${path.basename(mergedPath)}`);
        process.exit(1);
      }
      throw e;
    }
  }

  // 6. Check gen invariant (unconditional)
  if (!dafnyCheckDiff(genPath, dfyPath)) {
    console.error(`FAILED: ${path.basename(dfyPath)} still modifies generated lines after merging — fix those lines in the proof file before verifying.`);
    process.exit(1);
  }

  // 7. Verify (skipped under --no-verify: caller verifies separately)
  if (!noVerify && !dafnyVerify(dfyPath, dir, timeLimit, extraFlags)) {
    // The clean merge already incorporated this generation into the proof
    // file. Keep that generation as the next merge anchor even though the
    // verifier rejected the current proof state; otherwise the next regen
    // compares against the pre-merge generation and can duplicate declarations.
    writeFileSync(basePath, text);
    console.error(`FAILED: ${path.basename(dfyPath)} verification failed.`);
    process.exit(1);
  }

  // 8. Success — delete base (gen is now the anchor)
  if (existsSync(basePath)) unlinkSync(basePath);
}
