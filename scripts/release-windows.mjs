#!/usr/bin/env node
// Builds Bops for Windows with its own server inside (no source folder needed to run it): the Windows
// counterpart of scripts/release.sh and scripts/server-bundle.sh. It
//   1. builds the server (next build, standalone) and keeps only what the server needs of it;
//   2. stops if any key from your .env files ended up in the build output;
//   3. packs the server bundle that bots' computers run (dist-runner), as server-bundle.sh does;
//   4. makes the installer (electron-builder, NSIS) in dist-desktop;
//   5. starts the packaged server once, with no keys, and checks it answers.
// The relay agent ("Route through this PC") and the ingot command are Orgo's private downloads: without
// them the build still works, without those two features. The installer isn't code-signed, so Windows
// SmartScreen asks once before it runs ("More info", then "Run anyway").
//
//   npm run app:release:win      (or node scripts/release-windows.mjs)
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const fail = (why) => {
  console.error(why);
  process.exit(1);
};
const run = (command, env = {}) => {
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", command], { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) fail(`${command} failed.`);
};
if (process.platform !== "win32") fail("Build the Windows app on Windows (scripts/release.sh builds the Mac one).");

// A release runs the server it carries, not the source folder's.
rmSync("desktop/repo.json", { force: true });

// 1. The server.
if (!process.env.BOPS_SERVER_BUILT) run("npx next build", { NEXT_PUBLIC_BOPS_BRAINS: "0" });
const standalone = join(".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) fail('No .next/standalone/server.js: is output "standalone" set in next.config.ts?');
for (const f of readdirSync(standalone)) {
  if (f.startsWith(".env") || f === ".data") rmSync(join(standalone, f), { recursive: true, force: true });
  else if (![".next", "cloud", "LICENSE", "node_modules", "package.json", "public", "server.js", "slack", "vm"].includes(f)) {
    console.log(`Not shipping ${f} (traced from the project, not part of the server).`);
    rmSync(join(standalone, f), { recursive: true, force: true });
  }
}

// 2. No key in the output.
const secretName = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|DATABASE_URL)/i;
const values = [];
for (const envFile of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (!existsSync(envFile)) continue;
  for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m || !secretName.test(m[1])) continue;
    const value = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value.length >= 12) values.push({ key: m[1], envFile, value });
  }
}
if (values.length) {
  const leaked = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.size < 50 * 1024 * 1024) {
        const text = readFileSync(p, "latin1");
        for (const v of values) if (text.includes(v.value)) leaked.add(`${v.key} (${v.envFile})`);
      }
    }
  };
  for (const d of [standalone, join(".next", "static"), "public"]) if (existsSync(d)) walk(d);
  if (leaked.size) fail(`Values of these settings are in the build output: ${[...leaked].join(", ")}. Not shipping.`);
}

// 3. The bundle bots' computers run.
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const buildId = readFileSync(join(".next", "BUILD_ID"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json's version (${version}) isn't x.y.z.`);
if (!/^[A-Za-z0-9_-]{1,64}$/.test(buildId)) fail(`The build's id (${buildId}) isn't one the runner can be named for.`);
const stage = mkdtempSync(join(tmpdir(), "bops-bundle-"));
try {
  const server = join(stage, "server");
  cpSync(standalone, server, { recursive: true, verbatimSymlinks: true });
  rmSync(join(server, ".next", "static"), { recursive: true, force: true });
  rmSync(join(server, "public"), { recursive: true, force: true });
  cpSync(join(".next", "static"), join(server, ".next", "static"), { recursive: true });
  cpSync("public", join(server, "public"), { recursive: true });
  mkdirSync("dist-runner", { recursive: true });
  for (const f of readdirSync("dist-runner")) if (f.startsWith("bops-server-")) rmSync(join("dist-runner", f));
  const name = `bops-server-${version}-${buildId}.tgz`;
  // Windows' own tar (bsdtar), with the owner set to root as the computers expect.
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const r = spawnSync(tar, ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root", "-czf", resolve("dist-runner", name), "-C", server, "."], { stdio: "inherit" });
  if (r.status !== 0) fail("Packing the server bundle failed.");
  const sum = createHash("sha256").update(readFileSync(join("dist-runner", name))).digest("hex");
  writeFileSync(join("dist-runner", `${name}.sha256`), `${sum}  ${name}\n`);
  console.log(`Server bundle: dist-runner/${name}.`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

// 4. The installer.
run("npx electron-builder --win nsis --x64 --publish never");

// 5. The packaged server answers, with no keys, as a fresh install's would.
const app = join("dist-desktop", "win-unpacked");
const exe = join(app, "Bops.exe");
const serverJs = resolve(app, "resources", "server", "server.js");
if (!existsSync(serverJs)) fail("The app doesn't carry its server (resources/server).");
const smoke = mkdtempSync(join(tmpdir(), "bops-smoke-"));
for (const f of readdirSync(dirname(serverJs))) {
  const from = join(dirname(serverJs), f);
  // Folders as junctions (no admin needed), files copied: as the app itself does (desktop/main.cjs).
  if (statSync(from).isDirectory()) spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", join(smoke, f), from], { stdio: "ignore" });
  else cpSync(from, join(smoke, f));
}
const child = spawn(resolve(exe), ["-e", "process.chdir = () => {}; require(process.env.BOPS_SERVER_JS)"], {
  cwd: smoke,
  // The copy of server.js in the working folder, as the app runs it (desktop/main.cjs).
  env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, USERPROFILE: smoke, APPDATA: smoke, LOCALAPPDATA: smoke, TEMP: smoke, TMP: smoke, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", PORT: "3299", HOSTNAME: "127.0.0.1", BOPS_SERVER_JS: join(smoke, "server.js") },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const answer = async (path) => {
  try {
    return (await fetch(`http://127.0.0.1:3299${path}`, { signal: AbortSignal.timeout(20_000) })).status;
  } catch {
    return 0;
  }
};
let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  ok = (await answer("/api/health")) === 200;
  if (!ok) await new Promise((r) => setTimeout(r, 1000));
}
if (ok)
  for (const route of ["/", "/api/state"]) {
    const code = await answer(route);
    if (code !== 200) {
      console.error(`${route} answered ${code} without keys.`);
      ok = false;
    }
  }
spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
if (!ok || /Cannot find module|MODULE_NOT_FOUND|ENOENT/.test(log)) {
  console.error("The bundled server failed its smoke test; its log:");
  console.error(log.split("\n").slice(0, 40).join("\n"));
  process.exit(1);
}
// The junctions go first, on their own: removing one never touches the app's files it points to.
for (const f of readdirSync(smoke)) {
  const p = join(smoke, f);
  if (lstatSync(p).isSymbolicLink()) rmdirSync(p);
}
rmSync(smoke, { recursive: true, force: true });
console.log("Bundled server smoke test passed.");
console.log(`Installer: ${readdirSync("dist-desktop").filter((f) => f.endsWith(".exe")).map((f) => join("dist-desktop", f)).join(", ")}`);
