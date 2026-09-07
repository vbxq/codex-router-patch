import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isAppServerArgs,
  rewriteModelListLine,
  resolveRealCodexPath,
} from "../src/codex-model-list-shim.mjs";

test("expands the initial model/list page so Desktop receives the full catalog", () => {
  const input = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "model/list",
    params: { includeHidden: true, cursor: null, limit: 100 },
  });

  const output = JSON.parse(rewriteModelListLine(input));

  assert.deepEqual(output, {
    jsonrpc: "2.0",
    id: 7,
    method: "model/list",
    params: { includeHidden: true, cursor: null, limit: 1000 },
  });
});

test("leaves later pages and unrelated app-server requests untouched", () => {
  const laterPage = JSON.stringify({
    jsonrpc: "2.0",
    id: 8,
    method: "model/list",
    params: { includeHidden: true, cursor: "100", limit: 100 },
  });
  const unrelated = JSON.stringify({
    jsonrpc: "2.0",
    id: 9,
    method: "initialize",
    params: { clientInfo: { name: "codex" } },
  });

  assert.equal(rewriteModelListLine(laterPage), laterPage);
  assert.equal(rewriteModelListLine(unrelated), unrelated);
});

test("passes malformed or blank lines through unchanged", () => {
  assert.equal(rewriteModelListLine(""), "");
  assert.equal(rewriteModelListLine("not json"), "not json");
});

test("recognizes only app-server invocations for JSONL interception", () => {
  assert.equal(isAppServerArgs(["app-server", "--stdio"]), true);
  assert.equal(isAppServerArgs(["-c", "model=x", "app-server"]), true);
  assert.equal(isAppServerArgs(["login"]), false);
});

test("the executable shim rewrites a live JSONL stream and leaves its child in charge", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-model-list-shim-"));
  const realCodex = path.join(directory, "codex");
  writeFileSync(
    realCodex,
    "#!/usr/bin/env node\nprocess.stdin.setEncoding('utf8'); let data = ''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => process.stdout.write(data));\n",
    { mode: 0o755 },
  );
  chmodSync(realCodex, 0o755);

  try {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "model/list",
      params: { includeHidden: true, cursor: null, limit: 100 },
    });
    const output = execFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "codex-model-list-shim"),
      ["app-server", "--stdio"],
      {
        env: { ...process.env, CODEX_ROUTER_REAL_CODEX: realCodex },
        input: `${request}\n`,
        encoding: "utf8",
      },
    );

    assert.deepEqual(JSON.parse(output), {
      jsonrpc: "2.0",
      id: 11,
      method: "model/list",
      params: { includeHidden: true, cursor: null, limit: 1000 },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit real Codex path wins over the shim's fallback search", () => {
  assert.equal(
    resolveRealCodexPath({ CODEX_ROUTER_REAL_CODEX: "/opt/codex/resources/codex", PATH: "" }),
    "/opt/codex/resources/codex",
  );
});
