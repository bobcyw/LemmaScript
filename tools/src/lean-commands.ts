/**
 * Lean backend commands: gen, check.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";

/** Lake target for an emitted module name. The guillemets are load-bearing:
 *  emitted modules contain a dot (`foo.def`), and Lake reads a bare `foo.def`
 *  as a target that does not exist. */
function lakeTarget(moduleBase: string, suffix: string): string {
  return `«${moduleBase}.${suffix}»`;
}

/** Module names declared in the project's explicit `roots` lists, reduced to
 *  their trailing `base.suffix` components. `explicit` is false when no roots
 *  list is written down (Lake then treats every module under the library's
 *  source directory as a root, so absence proves nothing). */
function declaredRootStems(lakeDir: string): { stems: Set<string>; explicit: boolean } {
  const stems = new Set<string>();
  let explicit = false;
  const parse = (text: string) => {
    for (const block of text.matchAll(/\broots\s*:?=\s*#?\[([\s\S]*?)\]/g)) {
      explicit = true;
      // Name literals are one backtick prefix plus an identifier: `foo or
      // `«foo.def» (the guillemets are what keep the dot inside one component).
      for (const name of block[1].matchAll(/`«([^»]+)»|`([A-Za-z0-9_.]+)|"([A-Za-z0-9_.]+)"/g)) {
        const full = name[1] ?? name[2] ?? name[3];
        stems.add(full.split(".").slice(-2).join("."));
      }
    }
  };
  for (const marker of ["lakefile.lean", "lakefile.toml"]) {
    const file = path.join(lakeDir, marker);
    if (existsSync(file)) parse(readFileSync(file, "utf-8"));
  }
  return { stems, explicit };
}

/** True when Lake rejected `moduleName` itself, rather than something it imports. */
function unknownTarget(output: string, moduleName: string): boolean {
  const match = output.match(/unknown target\s+`?«?([^»`\s]+)»?`?/);
  return match?.[1] === moduleName;
}

export function leanGen(typesPath: string | null, defPath: string, typesText: string | null, defText: string) {
  if (typesPath && typesText) {
    writeFileSync(typesPath, typesText);
    console.log(`Generated: ${typesPath}`);
  }
  writeFileSync(defPath, defText);
  console.log(`Generated: ${defPath}`);
}

/** Find the nearest ancestor containing either supported Lake configuration. */
export function findLakeProjectRoot(dir: string): string | null {
  let candidate = path.resolve(dir);
  while (true) {
    if (existsSync(path.join(candidate, "lakefile.lean")) ||
        existsSync(path.join(candidate, "lakefile.toml"))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    // Check the filesystem root above before terminating the search.
    if (parent === candidate) return null;
    candidate = parent;
  }
}

export function leanCheck(dir: string, base: string): boolean {
  const proofPath = path.join(dir, `${base}.proof.lean`);
  if (!existsSync(proofPath)) {
    console.error(`No proof file: ${proofPath}`);
    return false;
  }

  const lakeDir = findLakeProjectRoot(dir);
  if (lakeDir === null) {
    console.error(
      `No Lake project found for ${path.resolve(dir)}: expected lakefile.lean or lakefile.toml ` +
      "in this directory or an ancestor. Run this check inside a Lake project; lake was not started.",
    );
    return false;
  }

  // Ask Lake for this module by name before building the project. A project-wide
  // `lake build` never mentions modules that no library reaches: an unregistered
  // `foo.proof.lean` compiles nothing and still exits 0, so a green run would say
  // nothing about the file we were asked to check.
  const proofTarget = `«${base}.proof»`;
  try {
    execFileSync("lake", ["build", proofTarget], {
      cwd: lakeDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8",
    });
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      console.error("ERROR: `lake` not found on PATH — the Lean check never ran. Install the Lean toolchain (https://leanprover.github.io/lean4/doc/setup.html).");
      return false;
    }
    const output = `${typeof e?.stdout === "string" ? e.stdout : ""}${typeof e?.stderr === "string" ? e.stderr : ""}`;
    if (!unknownTarget(output, `${base}.proof`)) {
      // Lake rejected the target for some other reason (for example a module it
      // does not index the way we guessed). Do not turn that into a verdict: a
      // wrong "failed" here would be as bad as the green we are trying to
      // prevent. The project-wide build below is the authority.
      console.error(`Note: \`lake build ${proofTarget}\` failed; falling back to the project-wide build.`);
      if (output.trim()) process.stderr.write(output);
    } else {
      const declared = declaredRootStems(lakeDir);
      if (declared.explicit && !declared.stems.has(`${base}.proof`) && !declared.stems.has(`${base}.def`)) {
        console.error(
          `ERROR: Lean module «${base}.proof» is not registered in the Lake project at ${lakeDir}.\n` +
          "`lake build` succeeds without ever compiling it, so this check would pass without checking anything.\n" +
          `Add the emitted modules for this file to the library's \`roots\` list in lakefile.lean (or lakefile.toml):\n` +
          ["types", "def", "spec", "proof"]
            .map(suffix => `  ${lakeTarget(base, suffix)}`)
            .join("\n"),
        );
        return false;
      }
      // The roots list is computed rather than written down, or names the module
      // with a path prefix. Lake still cannot build it by that name, but this
      // check cannot tell "unregistered" from "registered under another name",
      // so the project-wide build below decides instead of a guess here.
      console.error(`Note: \`lake build ${proofTarget}\` is not a known target; falling back to the project-wide build.`);
    }
  }

  console.log("Running lake build...");
  try {
    execFileSync("lake", ["build"], { cwd: lakeDir, stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}
