import { accessSync, constants, statSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const DEFAULT_MODEL_LIST_LIMIT = 100;
export const EXPANDED_MODEL_LIST_LIMIT = 1000;
export const DEFAULT_REAL_CODEX = "/usr/lib/chatgpt/resources/codex";

function isExecutableFile(candidate) {
  try {
    statSync(candidate);
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite only the initial app-server model/list request. Codex Desktop sends
 * one page and currently does not follow the response cursor; the larger limit
 * keeps the router's complete catalog in that one response. Every other JSONL
 * message, including later pages, is passed through byte-for-byte.
 */
export function rewriteModelListLine(line) {
  if (typeof line !== "string" || line.trim().length === 0) return line;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }

  const params = message?.params;
  if (
    message?.method !== "model/list"
    || params == null
    || typeof params !== "object"
    || Array.isArray(params)
    || params.cursor !== null
    || params.limit !== DEFAULT_MODEL_LIST_LIMIT
  ) {
    return line;
  }

  return JSON.stringify({
    ...message,
    params: { ...params, limit: EXPANDED_MODEL_LIST_LIMIT },
  });
}

export function isAppServerArgs(args) {
  return Array.isArray(args) && args.includes("app-server");
}

function pathEntries(environment) {
  return String(environment.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => (entry === "~" ? os.homedir() : entry));
}

export function resolveRealCodexPath(environment = process.env) {
  const configured = environment.CODEX_ROUTER_REAL_CODEX?.trim();
  if (configured) return configured;

  const candidates = [
    DEFAULT_REAL_CODEX,
    "/usr/bin/codex",
    ...pathEntries(environment).map((directory) => path.join(directory, "codex")),
  ];
  const currentShim = environment.CODEX_CLI_PATH?.trim();
  for (const candidate of candidates) {
    if (candidate === currentShim) continue;
    if (isExecutableFile(candidate)) return candidate;
  }

  throw new Error(
    "codex-router: cannot find the real Codex binary; set CODEX_ROUTER_REAL_CODEX",
  );
}

function signalExitCode(signal) {
  const signals = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  return 128 + (signals[signal] || 1);
}

/**
 * Run the real Codex process and proxy its app-server JSONL transport. This is
 * intentionally a process-local adapter: it does not alter the installed
 * Electron archive or the router catalog.
 */
export function runModelListShim({
  args = process.argv.slice(2),
  environment = process.env,
  realCodex = resolveRealCodexPath(environment),
} = {}) {
  const child = spawn(realCodex, args, {
    env: (() => {
      const childEnvironment = { ...environment };
      // Prevent a nested app-server or helper process from selecting this shim.
      delete childEnvironment.CODEX_CLI_PATH;
      return childEnvironment;
    })(),
    stdio: isAppServerArgs(args) ? ["pipe", "pipe", "inherit"] : "inherit",
  });

  if (!isAppServerArgs(args)) {
    child.once("error", (error) => {
      console.error(`codex-router: failed to start Codex: ${error.message}`);
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      process.exitCode = code ?? signalExitCode(signal);
    });
    return child;
  }

  child.once("error", (error) => {
    console.error(`codex-router: failed to start Codex: ${error.message}`);
    process.exitCode = 1;
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!child.stdin.destroyed) child.stdin.write(`${rewriteModelListLine(line)}\n`);
  });
  input.on("close", () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.once("exit", (code, signal) => {
    input.close();
    process.stdin.pause();
    process.exitCode = code ?? signalExitCode(signal);
  });

  return child;
}

const invokedPath = process.argv[1] == null ? null : path.resolve(process.argv[1]);
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) runModelListShim();
