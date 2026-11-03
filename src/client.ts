/**
 * baba daemon client — repo resolution, daemon spawn, socket protocol,
 * result formatting.
 *
 * Shared by the pi extension (`src/index.ts`) and the `baba-search` CLI
 * (`bin/baba-search.ts`); neither owns a second copy of the protocol.
 *
 * Protocol: one JSON line per request/response over a Unix socket.
 *   Request:  {"type":"search","query":"...","top_k":<int>}
 *   Response: {"type":"results","results":[{source_type,source_path,heading_path,score,text},...]}
 *   Status:   {"type":"status","msg":"..."}
 *   Error:    {"type":"error","msg":"..."}
 *
 * Architecture (WO-014 / shared-daemon):
 *   - findMainRoot(cwd) → main repo root (handles worktrees via
 *     git-common-dir), or null outside a repo.
 *   - ensureDaemon(mainRoot) → one detached daemon at
 *     <repo>/.baba/daemon.sock; spawned on demand, survives sessions.
 *     Its stderr goes to <repo>/.baba/daemon.log; a caller waiting on a
 *     starting daemon gets that log's new lines as status.
 *   - Persistent socket client with reconnect-on-failure.
 *
 * Engine location (BABA_HOME):
 *   The baba engine lives in a separate repo. Set BABA_HOME to its root
 *   (e.g. ~/Developer/baba). The client finds the binary at
 *   BABA_HOME/core/target/debug/baba and the embedder at
 *   BABA_HOME/embedder/.venv/bin/python + server.py.
 *   Override with BABA_BIN / BABA_EMBEDDER env vars.
 */

import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { connect, type Socket } from "node:net";

// ── Types matching the serve protocol ───────────────────────────────

export interface SearchResult {
  source_type: string;
  source_path: string;
  heading_path: string;
  score: number;
  text: string;
}

export type ServeResponse =
  | { type: "results"; results: SearchResult[] }
  | { type: "status"; msg: string }
  | { type: "error"; msg: string };

export interface ServeRequest {
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
 * From a session CWD, find the main repository root.
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
 * Returns null when git cannot answer (git not found, not a repo, invalid
 * output, timeout). Callers that must name that failure — the CLI, which
 * exits non-zero rather than indexing an arbitrary directory — branch on
 * the null; `resolveMainRoot` is the extension's fallback wrapper.
 */
export function findMainRoot(cwd: string): string | null {
  try {
    const gitCommonDir = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--git-common-dir"],
      {
        encoding: "utf8",
        timeout: 5000,
        // "not a git repository" is an expected answer here, not a diagnostic:
        // the caller owns stderr and names the failure itself.
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    const mainRoot = resolve(cwd, dirname(gitCommonDir));

    if (existsSync(mainRoot)) {
      return mainRoot;
    }
  } catch {
    // git not found, not a repo, timeout, or any other failure → no answer
  }

  return null;
}

/**
 * Main repo root from a session CWD, falling back to cwd when git cannot
 * answer — the extension's behaviour, pinned by `test/client.test.ts`.
 */
export function resolveMainRoot(cwd: string): string {
  return findMainRoot(cwd) ?? cwd;
}

// ── Daemon lifecycle ─────────────────────────────────────────────────

// 120s — cold-start indexing (embedder model load + first index) can take 45-60s.
const DAEMON_START_TIMEOUT_MS = 120_000;
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

/**
 * Poll for a socket to appear on disk and accept connections. `drain` runs
 * on each poll and once more when the wait ends, so the caller sees the log
 * lines written before the socket bound.
 */
function waitForSocket(
  sockPath: string,
  timeoutMs: number,
  drain: () => void,
): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();

    const finish = (err?: Error) => {
      drain();
      if (err) rej(err);
      else res();
    };

    const poll = () => {
      drain();
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        return finish(
          new Error(
            `baba daemon failed to start within ${timeoutMs / 1000}s (socket file never appeared)`,
          ),
        );
      }

      if (existsSync(sockPath)) {
        // Socket file exists — verify it accepts connections.
        canConnect(sockPath, SOCKET_CONNECT_TIMEOUT_MS).then((ok) => {
          if (ok) return finish();
          if (Date.now() - start >= timeoutMs) {
            return finish(
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
 * Reads a daemon log from `offset`, passing each complete new line to
 * `onStatus`. Opens the file per call, so no handle outlives a poll. A
 * throwing callback is reported on stderr and does not stop the reader.
 */
function logTail(
  logPath: string,
  offset: number,
  onStatus: (msg: string) => void,
): { drain: () => void } {
  let pos = offset;
  let partial = "";
  return {
    drain() {
      let size: number;
      try {
        size = statSync(logPath).size;
      } catch {
        return; // no log yet
      }
      if (size < pos) {
        // Truncated by a later spawn: read the new file from its start.
        pos = 0;
        partial = "";
      }
      if (size === pos) return;

      const buf = Buffer.alloc(size - pos);
      const fd = openSync(logPath, "r");
      try {
        readSync(fd, buf, 0, buf.length, pos);
      } finally {
        closeSync(fd);
      }
      pos = size;

      const lines = (partial + buf.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        try {
          onStatus(logMessage(line));
        } catch (err) {
          console.error(`baba-client: status callback threw: ${err}`);
        }
      }
    },
  };
}

/**
 * What a log line reports to the caller. The daemon writes status lines as
 * `{"type":"status","msg":...}` JSON and everything else (panics, raw stderr)
 * as text; a status line reports its `msg`, any other line is passed through.
 */
function logMessage(line: string): string {
  try {
    const parsed = JSON.parse(line) as { type?: unknown; msg?: unknown };
    if (parsed.type === "status" && typeof parsed.msg === "string") {
      return parsed.msg;
    }
  } catch {
    // Not JSON: a text line.
  }
  return line;
}

/** Byte length of the log now; a waiter starts tailing from here. */
function logSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

/**
 * Ensure a baba daemon is running for the given main repo root.
 * Returns the socket path on success.
 *
 * Liveness = (pid-alive) AND (socket-connects). A live pid with no socket
 * file is a daemon still in its startup catch-up (it binds the socket after
 * that): this caller waits for it and tails its log instead of spawning a
 * second one. A dead pid or a socket that refuses connections is stale: the
 * files are cleaned up and a daemon is spawned detached.
 *
 * `onStatus` receives the daemon log's lines while this call waits for the
 * socket, from the end of the log when it found a daemon already starting,
 * from the start of the fresh log when it spawned one.
 *
 * Race tolerance: two sessions may call this simultaneously; the first to
 * bind wins (WO-010), the loser gets EADDRINUSE and exits. We retry
 * liveness after spawn — if the other session's daemon is now alive,
 * we connect to it. Max 2 spawn attempts.
 */
export async function ensureDaemon(
  mainRoot: string,
  onStatus: (msg: string) => void = () => {},
): Promise<string> {
  const babaDir = resolve(mainRoot, ".baba");
  const sockPath = resolve(babaDir, "daemon.sock");
  const pidPath = resolve(babaDir, "daemon.pid");
  const logPath = resolve(babaDir, "daemon.log");

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
    let pidAlive = false;
    try {
      const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      pidAlive = !isNaN(pid) && isPidAlive(pid);
    } catch {
      // pid file doesn't exist or is unreadable — not alive.
    }

    if (pidAlive) {
      if (!existsSync(sockPath)) {
        // Starting: another caller spawned it and it has not bound yet.
        const tail = logTail(logPath, logSize(logPath), onStatus);
        await waitForSocket(sockPath, DAEMON_START_TIMEOUT_MS, tail.drain);
        return sockPath;
      }
      if (await canConnect(sockPath, SOCKET_CONNECT_TIMEOUT_MS)) {
        return sockPath;
      }
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
    // The log is truncated per spawn: it holds this daemon's startup only.
    mkdirSync(babaDir, { recursive: true });
    writeFileSync(logPath, "");
    const logFd = openSync(logPath, "a");
    const child = spawn(
      bin,
      ["serve", "--repo", mainRoot, "--socket", sockPath],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env,
      },
    );
    closeSync(logFd);
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`failed to spawn ${bin}`);
    }
    // Written at spawn so a second caller sees the daemon as starting.
    // The daemon writes the same pid when it binds.
    writeFileSync(pidPath, `${child.pid}\n`);

    // Wait for the socket to appear.
    const tail = logTail(logPath, 0, onStatus);
    try {
      await waitForSocket(sockPath, DAEMON_START_TIMEOUT_MS, tail.drain);
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
export function daemonRequest(
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
      let settled = false;

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rej(err);
      };

      const onEnd = () => {
        if (settled) return;
        settled = true;
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
            if (settled) return;
            settled = true;
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
              if (settled) return;
              settled = true;
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
                if (settled) return;
                settled = true;
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
            if (settled) return;
            settled = true;
            cleanup();
            rej(err);
          });

          rl.on("close", () => {
            if (settled) return;
            settled = true;
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

export function formatResults(results: SearchResult[]): string {
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


// ── Query ───────────────────────────────────────────────────────────

/** `top_k` for a search that names none. */
export const DEFAULT_TOP_K = 10;

/** Whether `n` is a usable `top_k`: a positive integer. */
export function validTopK(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}

/**
 * One semantic query: resolve the main repo from `cwd`, ensure the daemon,
 * send the query. Resolves to the text the CLI prints on stdout. Rejects with
 * an Error whose message is the failure reason. `onStatus` gets each status
 * line in order, before the result or the rejection.
 */
export async function search(
  cwd: string,
  query: string,
  topK: number,
  onStatus: (msg: string) => void,
): Promise<string> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new Error("empty query");
  }

  const mainRoot = findMainRoot(cwd);
  if (mainRoot === null) {
    // findMainRoot collapses "not a repo", "no git", "unparseable" and
    // "root vanished" into null; the message names both live cases.
    throw new Error(
      `${cwd} is not inside a git repository, or git could not answer — baba indexes a repo's main checkout, so run this from one (or from a worktree of one)`,
    );
  }

  const sockPath = await ensureDaemon(mainRoot, onStatus);
  const response = await daemonRequest(
    { type: "search", query: trimmed, top_k: topK },
    sockPath,
  );

  for (const status of (response as { statuses?: string[] }).statuses ?? []) {
    onStatus(status);
  }

  switch (response.type) {
    case "results":
      return `${formatResults(response.results)}\n`;
    case "error":
      throw new Error(`baba error: ${response.msg}`);
    default:
      // The client's read loop returns only `results` or `error`.
      throw new Error(`unexpected response: ${JSON.stringify(response)}`);
  }
}
