/**
 * baba pi extension
 *
 * Spawns the baba Rust core `serve` process as a shared-detached daemon
 * and exposes a `semantic_search` tool to the LLM. All pi sessions
 * (orchestrator + subagents) share one daemon per main repository.
 *
 * Protocol: one JSON line per request/response over a Unix socket.
 *   Request:  {"type":"search","query":"...","top_k":<int>}
 *   Response: {"type":"results","results":[{source_type,source_path,heading_path,score,text},...]}
 *   Status:   {"type":"status","msg":"..."}
 *   Error:    {"type":"error","msg":"..."}
 *
 * Architecture (WO-014 / shared-daemon):
 *   - resolveMainRoot(cwd) → main repo root (handles worktrees via
 *     git-common-dir).
 *   - ensureDaemon(mainRoot) → one detached daemon at
 *     <repo>/.baba/daemon.sock; spawned on demand, survives sessions.
 *   - Persistent socket client with reconnect-on-failure.
 *   - session_shutdown → no-op (daemon is shared; self-exits after
 *     BABA_DAEMON_IDLE_SECS of inactivity, default 600s).
 *
 * Engine location (BABA_HOME):
 *   The baba engine lives in a separate repo. Set BABA_HOME to its root
 *   (e.g. ~/Developer/baba). The extension finds the binary at
 *   BABA_HOME/core/target/debug/baba and the embedder at
 *   BABA_HOME/embedder/.venv/bin/python + server.py.
 *   Override with BABA_BIN / BABA_EMBEDDER env vars.
 */

import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { connect, type Socket } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Types matching the serve protocol ───────────────────────────────

interface SearchResult {
  source_type: string;
  source_path: string;
  heading_path: string;
  score: number;
  text: string;
}

type ServeResponse =
  | { type: "results"; results: SearchResult[] }
  | { type: "status"; msg: string }
  | { type: "error"; msg: string };

interface ServeRequest {
  type: "search";
  query: string;
  top_k: number;
}

// ── Path resolution (BABA_HOME / PATH fallback) ─────────────────────

/**
 * Resolve the baba engine root. Priority:
 * 1. BABA_HOME env var (explicit, recommended)
 * 2. Directory containing the `baba` binary on PATH
 * 3. null — callers must handle (set BABA_HOME or BABA_BIN / BABA_EMBEDDER)
 */
function findBabaHome(): string | null {
  if (process.env.BABA_HOME) {
    return process.env.BABA_HOME;
  }
  // Try to find baba on PATH and derive the engine root from it.
  try {
    const binPath = execFileSync("which", ["baba"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    // baba binary is at <engine>/core/target/debug/baba or similar.
    // Walk up from the binary location to find the engine root (has core/ dir).
    let dir = dirname(binPath);
    for (let i = 0; i < 5; i++) {
      if (existsSync(resolve(dir, "core", "Cargo.toml"))) {
        return dir;
      }
      dir = dirname(dir);
    }
  } catch {
    // baba not on PATH — fine.
  }
  return null;
}

/** Resolve the path to the baba binary. */
function resolveCoreBin(): string {
  if (process.env.BABA_BIN) {
    return process.env.BABA_BIN;
  }
  const home = findBabaHome();
  if (home) {
    return resolve(home, "core", "target", "debug", "baba");
  }
  // Last resort: hope it's on PATH
  return "baba";
}

/**
 * The embedder command: run server.py by ABSOLUTE path. Do NOT use
 * `python -m embedder.server` — that needs cwd=baba-repo-root for the
 * `embedder` package import, and the session cwd may be any repo.
 * server.py is self-contained (no intra-package imports) and locates its
 * CoreML model via `os.path.dirname(__file__)`, so it is cwd-independent.
 */
function embedderCmd(): string | null {
  if (process.env.BABA_EMBEDDER) {
    return process.env.BABA_EMBEDDER;
  }
  const home = findBabaHome();
  if (home) {
    const py = resolve(home, "embedder", ".venv", "bin", "python");
    const server = resolve(home, "embedder", "server.py");
    if (existsSync(py) && existsSync(server)) {
      return `${py} ${server}`;
    }
  }
  return null;
}

// ── Repo resolution ─────────────────────────────────────────────────

/**
 * From a session CWD, resolve the main repository root.
 *
 * Uses `git rev-parse --git-common-dir` to find the shared git directory,
 * then derives the main repo root via `dirname`. This handles both normal
 * repos and git worktrees uniformly:
 *
 * - Normal repo: `git-common-dir` → ".git"; dirname(".git") → ".";
 *   resolve(cwd, ".") → cwd itself.
 * - Worktree: `git-common-dir` → "<mainRoot>/.git" (absolute);
 *   dirname → "<mainRoot>".
 *
 * On any failure (git not found, not a repo, invalid output, timeout),
 * falls back to cwd — preserving today's behavior for non-worktree cases.
 */
function resolveMainRoot(cwd: string): string {
  try {
    const gitCommonDir = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--git-common-dir"],
      { encoding: "utf8", timeout: 5000 },
    ).trim();

    const mainRoot = resolve(cwd, dirname(gitCommonDir));

    if (existsSync(mainRoot)) {
      return mainRoot;
    }
  } catch {
    // git not found, not a repo, timeout, or any other failure → fallback
  }

  return cwd;
}

// ── Daemon lifecycle ─────────────────────────────────────────────────

const DAEMON_START_TIMEOUT_MS = 30_000;
const DAEMON_POLL_INTERVAL_MS = 500;
const SOCKET_CONNECT_TIMEOUT_MS = 2_000;

/** Check if a PID is alive (throws if not). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if a Unix socket accepts connections within a timeout. */
function canConnect(
  sockPath: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(sockPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);

    sock.on("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });

    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Poll for a socket to appear on disk and accept connections. */
function waitForSocket(
  sockPath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();

    const poll = () => {
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        return rej(
          new Error(
            `baba daemon failed to start within ${timeoutMs / 1000}s (socket file never appeared)`,
          ),
        );
      }

      if (existsSync(sockPath)) {
        // Socket file exists — verify it accepts connections.
        canConnect(sockPath, SOCKET_CONNECT_TIMEOUT_MS).then((ok) => {
          if (ok) return res();
          if (Date.now() - start >= timeoutMs) {
            return rej(
              new Error(
                `baba daemon failed to start within ${timeoutMs / 1000}s (socket not accepting connections)`,
              ),
            );
          }
          setTimeout(poll, DAEMON_POLL_INTERVAL_MS);
        });
        return;
      }

      setTimeout(poll, DAEMON_POLL_INTERVAL_MS);
    };

    poll();
  });
}

/**
 * Ensure a baba daemon is running for the given main repo root.
 * Returns the socket path on success.
 *
 * Liveness = (pid-alive) AND (socket-connects).
 * If either check fails → clean up stale files → spawn detached.
 *
 * Race tolerance: two sessions may call this simultaneously; the first to
 * bind wins (WO-010), the loser gets EADDRINUSE and exits. We retry
 * liveness after spawn — if the other session's daemon is now alive,
 * we connect to it. Max 2 spawn attempts.
 */
async function ensureDaemon(mainRoot: string): Promise<string> {
  const sockPath = resolve(mainRoot, ".baba", "daemon.sock");
  const pidPath = resolve(mainRoot, ".baba", "daemon.pid");

  const bin = resolveCoreBin();
  // Verify the binary exists (unless it's a bare name hoping for PATH).
  if (bin.includes("/") && !existsSync(bin)) {
    const home = findBabaHome();
    const hint = home
      ? `Set BABA_BIN to the correct path, or rebuild with \`cargo build\`.`
      : `Set BABA_HOME to the baba engine repo, or BABA_BIN to the binary path.`;
    throw new Error(`baba binary not found at ${bin}. ${hint}`);
  }

  // Propagate the parent env, then inject BABA_EMBEDDER so the core can
  // find the embedder regardless of the session cwd. Don't override an
  // explicit BABA_EMBEDDER / BABA_FAKE_EMBEDDER (user config / tests).
  const env = { ...process.env };
  if (!env.BABA_EMBEDDER && !env.BABA_FAKE_EMBEDDER) {
    const cmd = embedderCmd();
    if (cmd) {
      env.BABA_EMBEDDER = cmd;
    }
    // If cmd is null, the daemon will need BABA_EMBEDDER set externally
    // or it will fail to spawn the embedder (with a clear error).
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    // ── Liveness check: pid-alive AND socket-connects ────────────
    let daemonAlive = false;

    try {
      const pidRaw = readFileSync(pidPath, "utf8").trim();
      const pid = parseInt(pidRaw, 10);
      if (!isNaN(pid) && isPidAlive(pid)) {
        // PID alive — check socket.
        daemonAlive = await canConnect(sockPath, SOCKET_CONNECT_TIMEOUT_MS);
      }
    } catch {
      // pid file doesn't exist or is unreadable — not alive.
    }

    if (daemonAlive) {
      return sockPath;
    }

    // ── Clean up stale files ────────────────────────────────────
    try {
      unlinkSync(pidPath);
    } catch {
      // didn't exist — fine.
    }
    try {
      unlinkSync(sockPath);
    } catch {
      // didn't exist — fine.
    }

    // ── Spawn detached daemon ───────────────────────────────────
    const child = spawn(
      bin,
      ["serve", "--repo", mainRoot, "--socket", sockPath],
      {
        detached: true,
        stdio: "ignore",
        env,
      },
    );
    child.unref();

    // Wait for the socket to appear.
    try {
      await waitForSocket(sockPath, DAEMON_START_TIMEOUT_MS);
      return sockPath;
    } catch (waitErr) {
      // If this is our last attempt, re-throw.
      if (attempt >= 1) {
        throw waitErr;
      }
      // Otherwise, loop back: re-check liveness (the other racer
      // may have won) or try spawning again.
    }
  }

  // Unreachable (loop always returns or throws after 2 attempts).
  throw new Error("baba daemon failed to start");
}

// ── Socket client ────────────────────────────────────────────────────

/** Persistent socket connection — one per extension instance. */
let daemonSocket: Socket | null = null;
/** Serialises requests so only one is in flight at a time. */
let requestQueue: Promise<void> = Promise.resolve();

/**
 * Get or create a persistent socket connection to the daemon.
 * On any connection error, the socket is discarded and re-created
 * on the next call.
 */
function getSocket(sockPath: string): Socket {
  if (daemonSocket && !daemonSocket.destroyed) {
    return daemonSocket;
  }

  daemonSocket = connect(sockPath);
  daemonSocket.setEncoding("utf8");

  daemonSocket.on("close", () => {
    daemonSocket = null;
  });

  daemonSocket.on("error", () => {
    daemonSocket?.destroy();
    daemonSocket = null;
  });

  return daemonSocket;
}

/**
 * Send a request to the daemon and return the terminal Response.
 * Handles reconnect-on-failure (one retry) and enforces serialised
 * access via the requestQueue.
 */
function daemonRequest(
  req: ServeRequest,
  sockPath: string,
): Promise<ServeResponse> {
  let resolvePromise!: (value: ServeResponse) => void;
  let rejectPromise!: (reason: Error) => void;
  const promise = new Promise<ServeResponse>((res, rej) => {
    resolvePromise = res;
    rejectPromise = rej;
  });

  requestQueue = requestQueue.then(() =>
    daemonRequestOnce(req, sockPath).then(resolvePromise, rejectPromise),
  );

  return promise;
}

/** Raw send-one over the socket (called from the queue). */
async function daemonRequestOnce(
  req: ServeRequest,
  sockPath: string,
): Promise<ServeResponse> {
  let sock = getSocket(sockPath);

  const doSend = (): Promise<ServeResponse> => {
    return new Promise<ServeResponse>((res, rej) => {
      let rl: ReturnType<typeof createInterface> | null = null;

      const onError = (err: Error) => {
        cleanup();
        rej(err);
      };

      const onEnd = () => {
        cleanup();
        rej(new Error("baba daemon closed the connection"));
      };

      const cleanup = () => {
        sock.removeListener("error", onError);
        sock.removeListener("end", onEnd);
        if (rl) rl.close();
      };

      // Write request + read response once the socket is connected.
      const proceed = () => {
        sock.removeListener("error", onError);
        sock.removeListener("end", onEnd);

        const line = JSON.stringify(req) + "\n";
        sock.write(line, (writeErr) => {
          if (writeErr) {
            cleanup();
            rej(
              writeErr instanceof Error
                ? writeErr
                : new Error(String(writeErr)),
            );
            return;
          }

          // Read response lines until terminal "results" or "error".
          rl = createInterface({ input: sock, crlfDelay: Infinity });
          let statusMessages: string[] = [];

          rl.on("line", (raw: string) => {
            let parsed: ServeResponse;
            try {
              parsed = JSON.parse(raw) as ServeResponse;
            } catch {
              cleanup();
              rej(
                new Error(
                  `baba daemon returned invalid JSON: ${raw.slice(0, 200)}`,
                ),
              );
              return;
            }

            switch (parsed.type) {
              case "status":
                statusMessages.push(parsed.msg);
                break; // keep reading
              case "results":
              case "error":
                cleanup();
                // Attach any preceding status messages.
                if (statusMessages.length > 0) {
                  (parsed as { statuses?: string[] }).statuses =
                    statusMessages;
                }
                res(parsed);
                break;
              default:
                // Unknown type — keep reading (future compatibility).
                break;
            }
          });

          rl.on("error", (err: Error) => {
            cleanup();
            rej(err);
          });

          rl.on("close", () => {
            cleanup();
            rej(new Error("baba daemon closed the connection"));
          });
        });
      };

      if (sock.readyState === "open") {
        proceed();
      } else {
        sock.on("connect", proceed);
        sock.on("error", onError);
        sock.on("end", onEnd);
      }
    });
  };

  try {
    return await doSend();
  } catch (err) {
    // Reconnect once and retry.
    if (daemonSocket) {
      daemonSocket.destroy();
      daemonSocket = null;
    }
    sock = getSocket(sockPath);
    return await doSend();
  }
}

// ── Formatting ──────────────────────────────────────────────────────

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No results found.";
  }

  const lines: string[] = [];
  for (const [i, r] of results.entries()) {
    const heading = r.heading_path ? ` — ${r.heading_path}` : "";
    lines.push(
      `${i + 1}. [${r.score.toFixed(3)}] ${r.source_path}${heading}`,
    );
    lines.push(`   ${r.text}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ── Extension factory ────────────────────────────────────────────────

export default function babaExtension(pi: ExtensionAPI) {
  // ── Tool registration ──────────────────────────────────────────

  pi.registerTool({
    name: "semantic_search",
    label: "Semantic Search",
    description:
      "Semantic code search over the main repository's docs and code " +
      "(not your current worktree). Returns ranked chunks with path, " +
      "heading, snippet, and relevance score.",
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language search query",
      }),
      top_k: Type.Optional(
        Type.Number({
          description: "Number of results to return (default 10)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const query: string = params.query;
      const topK: number =
        typeof params.top_k === "number" ? Math.floor(params.top_k) : 10;

      if (!query || query.trim().length === 0) {
        return {
          content: [{ type: "text", text: "Error: empty query." }],
          details: {},
        };
      }

      try {
        const mainRoot = resolveMainRoot(ctx.cwd);
        const sockPath = await ensureDaemon(mainRoot);

        const response = await daemonRequest(
          {
            type: "search",
            query: query.trim(),
            top_k: topK,
          },
          sockPath,
        );

        // Surface any preceding status messages.
        const statuses: string[] = (response as { statuses?: string[] })
          .statuses ?? [];

        switch (response.type) {
          case "results": {
            let text = formatResults(response.results);
            if (statuses.length > 0) {
              text =
                statuses
                  .map((s) => `[baba] ${s}`)
                  .join("\n") +
                "\n\n" +
                text;
            }
            return {
              content: [{ type: "text", text }],
              details: {},
            };
          }
          case "error": {
            let text = `baba error: ${response.msg}`;
            if (statuses.length > 0) {
              text =
                statuses
                  .map((s) => `[baba] ${s}`)
                  .join("\n") +
                "\n" +
                text;
            }
            return {
              content: [{ type: "text", text }],
              details: {},
            };
          }
          case "status":
            // Shouldn't happen — read loop only returns results/error.
            // If it does, treat as informational.
            return {
              content: [
                { type: "text", text: `baba: ${response.msg}` },
              ],
              details: {},
            };
          default:
            return {
              content: [
                {
                  type: "text",
                  text: `baba returned unexpected response type: ${JSON.stringify(response)}`,
                },
              ],
              details: {},
            };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `baba tool error: ${message}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // ── Lifecycle ───────────────────────────────────────────────────

  // Daemon is shared and detached — other sessions may still use it.
  // The daemon self-exits after BABA_DAEMON_IDLE_SECS (default 600s)
  // of inactivity. session_shutdown is intentionally a no-op.
}
