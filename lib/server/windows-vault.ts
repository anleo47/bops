import "server-only";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bopsHome } from "./user-paths";

/**
 * Windows' stand-in for the Mac's Keychain (keychain.ts): the same secrets (a saved login's password and
 * 2FA key, a channel's token, the Orgo key), sealed so only this Windows user on this PC can open them.
 *
 * Each secret is encrypted with AES-256-GCM under one random key. That key is kept sealed by Windows
 * DPAPI for the current user (~/.bops/vault/key.dpapi), so copying the folder to another PC or account
 * opens nothing. PowerShell does the DPAPI step once per server start; the key and every secret go to it
 * on stdin, never in its arguments, so they don't show in the process list. The secrets themselves sit
 * in ~/.bops/vault/secrets.json, one sealed value per name.
 */

const dir = () => join(/*turbopackIgnore: true*/ bopsHome(), "vault");
const keyFile = () => join(/*turbopackIgnore: true*/ dir(), "key.dpapi");
const secretsFile = () => join(/*turbopackIgnore: true*/ dir(), "secrets.json");

/** Runs a PowerShell script with `input` on stdin; resolves with what it printed. */
function powershell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    p.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    p.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    p.once("error", reject);
    p.once("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`Windows couldn't seal the vault key: ${err.trim() || `exit ${code}`}`))));
    p.stdin.end(input);
  });
}

const DPAPI = (verb: "Protect" | "Unprotect") =>
  `Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${verb}($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;

const g = globalThis as typeof globalThis & { __bopsWinVaultKey?: Promise<Buffer>; __bopsWinVaultChain?: Promise<unknown> };

/** The vault's key: unsealed from its file, or made and sealed the first time. Once per process. */
function vaultKey(): Promise<Buffer> {
  g.__bopsWinVaultKey ??= (async () => {
    mkdirSync(dir(), { recursive: true });
    if (existsSync(keyFile())) {
      const sealed = readFileSync(keyFile(), "utf8").trim();
      const key = Buffer.from(await powershell(DPAPI("Unprotect"), sealed), "base64");
      if (key.length !== 32) throw new Error("The vault key on this PC is damaged.");
      return key;
    }
    const key = randomBytes(32);
    const sealed = await powershell(DPAPI("Protect"), key.toString("base64"));
    writeFileSync(keyFile(), `${sealed}\n`, { mode: 0o600 });
    return key;
  })();
  // A failure isn't kept: the next call tries again.
  g.__bopsWinVaultKey.catch(() => (g.__bopsWinVaultKey = undefined));
  return g.__bopsWinVaultKey;
}

type Sealed = Record<string, string>;

function readAll(): Sealed {
  try {
    const parsed = JSON.parse(readFileSync(secretsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Sealed) : {};
  } catch {
    return {};
  }
}

/** Written beside it and renamed over it, so it's never half-written. */
function writeAll(all: Sealed) {
  mkdirSync(dir(), { recursive: true });
  const tmp = `${secretsFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  renameSync(tmp, secretsFile());
}

/** One change at a time, each reading the file fresh. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__bopsWinVaultChain ?? Promise.resolve()).then(fn, fn);
  g.__bopsWinVaultChain = run.catch(() => {});
  return run;
}

function seal(key: Buffer, account: string, value: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  // The name is bound in, so a value moved to another name won't open there.
  c.setAAD(Buffer.from(account, "utf8"));
  const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

function open(key: Buffer, account: string, sealed: string) {
  const raw = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(account, "utf8"));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

export const windowsVault = {
  async set(account: string, value: string) {
    const key = await vaultKey();
    await serial(async () => {
      const all = readAll();
      all[account] = seal(key, account, value);
      writeAll(all);
    });
  },
  async get(account: string): Promise<string | null> {
    const sealed = readAll()[account];
    if (!sealed) return null;
    try {
      return open(await vaultKey(), account, sealed);
    } catch {
      return null;
    }
  },
  async remove(account: string) {
    await serial(async () => {
      const all = readAll();
      if (!(account in all)) return;
      delete all[account];
      writeAll(all);
    });
  },
};
