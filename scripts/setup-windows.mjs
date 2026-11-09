#!/usr/bin/env node
// Sets up this checkout for development on Windows, and says what's left: scripts/setup.sh's steps for
// a PC (which has no bash for npm to run it with). Run it again any time: it only adds what's missing,
// and never overwrites your .env.local.
//   1. Node 22 or newer, and the dependencies (npm install).
//   2. Electron's own program, which npm leaves to the first `npm run app` otherwise.
//   3. .env.local from .env.example, when there's none: fill in your keys (see "Run it on Windows" in
//      the README), or set BOPS_SELF_HOSTED=0 in it and sign in with Orgo.
//   4. The git hook (scripts/push-guard.sh), which Git for Windows runs with its own bash.
//
//   npm run setup:windows        (or node scripts/setup-windows.mjs)
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
console.log(`Setting up ${root}`);

// npm is a .cmd script on Windows, which only cmd.exe runs.
const npm = (args) => spawnSync("cmd.exe", ["/d", "/s", "/c", `npm ${args}`], { stdio: "inherit" });

// 1. Node and the dependencies.
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`Node ${process.version} is too old: Bops needs 22 or newer (https://nodejs.org).`);
  process.exit(1);
}
if (npm("install --no-audit --no-fund").status !== 0) {
  console.error("npm install failed: see what it said above.");
  process.exit(1);
}
console.log(`  - dependencies installed (Node ${process.version}).`);

// 2. Electron's program.
const electron = join(root, "node_modules", "electron");
if (existsSync(join(electron, "path.txt")) && existsSync(join(electron, "dist", readFileSync(join(electron, "path.txt"), "utf8").trim()))) {
  console.log("  - Electron is there.");
} else if (spawnSync(process.execPath, [join(electron, "install.js")], { stdio: "inherit" }).status === 0) {
  console.log("  - Electron downloaded.");
} else {
  console.log("  - Electron didn't download: npm run app tries again.");
}

// 3. .env.local.
if (existsSync(".env.local")) {
  console.log("  - .env.local is there; left as it is.");
} else {
  copyFileSync(".env.example", ".env.local");
  console.log("  - .env.local made from .env.example: fill in at least OPENAI_API_KEY and OPENAI_EXECUTOR_API_KEY,");
  console.log("    or set BOPS_SELF_HOSTED=0 in it and sign in with Orgo, which needs no keys of your own.");
}

// 4. The git hook: the same copy of scripts/push-guard.sh that setup.sh installs (Git for Windows runs it with its bash).
try {
  const hooks = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { encoding: "utf8" }).trim();
  const hook = join(hooks, "pre-push");
  const guard = readFileSync(join(root, "scripts", "push-guard.sh"), "utf8").replace(/\r\n/g, "\n");
  if (existsSync(hook) && !readFileSync(hook, "utf8").includes("bops-public-history-guard")) {
    console.log(`  - ${hook} is someone else's hook: left as it is.`);
  } else {
    mkdirSync(hooks, { recursive: true });
    writeFileSync(hook, guard, { mode: 0o755 });
    console.log(`  - git hook: pushes to github.com/OrgoAI/bops only carry its own history (${hook}).`);
  }
} catch {
  console.log("  - git hook skipped (this folder isn't a git checkout, or git isn't on the PATH).");
}

// What's left out on Windows.
console.log("  - relay agent skipped: \"Route through this PC\" needs Orgo's private relay, which has no Windows build here.");

console.log();
console.log("Next: npm run app (opens the app, which starts the server on port 3210).");
