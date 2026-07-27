# WO-014 — Extension socket wiring (shared daemon)

## Metadata

- **work_order_id**: WO-014
- **parent_plan_id**: shared-daemon (`docs/proposals/shared-daemon.md`)
- **sequence_position**: 3 of 3 (WO-010 = socket daemon, WO-011 = config discovery, this = extension wiring)
- **routed_to**: implement-pro
- **invariant_exhaustiveness**: implicit
- **priority**: normal
- **estimated_complexity**: complex
- **review_policy**: required
- **review_depth**: thorough (cross-file: socket client lifecycle, daemon spawn, race conditions, process management)

## Task Summary

**One-sentence description**: Replace the per-session stdio `baba serve` child process with a shared-detached daemon connection over a Unix socket, so all pi sessions (orchestrator + subagents) share one long-lived daemon per repo.

**Goal**: A production `extension/src/index.ts` where `resolveMainRoot` finds the main repo from any worktree/session CWD, `ensureDaemon` spawns a detached `baba serve --socket` on demand, and all `semantic_search` queries go over a persistent Unix socket with reconnect-on-failure. `session_shutdown` becomes a no-op (daemon is shared). `semantic_search` added to `scout-code.md` tools.

## Scope

**Files to modify**:
- `extension/src/index.ts` — full refactor: remove stdio child-process lifecycle (`ensureChild`, `killChild`, `sendRequest`, `sendRequestOnce`); add `resolveMainRoot`, `ensureDaemon`, socket client (`daemonRequest`, reconnect logic); update `execute` to use the new path; `session_shutdown` → no-op.
- `~/.pi/agent/agents/scout-code.md` — add `semantic_search` to the `tools:` frontmatter list.

**Files to read (reference only, do not modify)**:
- `extension/src/index.ts` — current code (the refactoring target; study the `ensureChild`/`sendRequest` patterns being replaced)
- `docs/proposals/shared-daemon.md` — architecture: one daemon per main-repo clone, socket at `<repo>/.baba/daemon.sock`, pid at `daemon.pid`, `resolveMainRoot` design, engine-single-target invariant, race-tolerance
- `docs/work-orders/wo-010-socket-daemon.md` — socket protocol contract (JSON-line Request/Response), path conventions (`daemon.sock`, `daemon.pid`), `BABA_DAEMON_IDLE_SECS` (default 600), stale-socket recovery, `EADDRINUSE` race tolerance
- `core/src/serve.rs:30-70` — `Request`/`Response` types (exact JSON shapes the socket client must speak)
- `core/src/serve.rs:415-460` — `handle_socket_connection` (server-side protocol: reads request lines, sends status-before-results, sends terminal response)
- `~/.pi/agent/agents/scout-code.md` — current `tools:` list format

**Files NOT to modify** (explicit guardrails):
- `core/**` — Rust engine unchanged; socket transport already implemented in WO-010
- `embedder/**` — Python unchanged
- `docs/proposals/shared-daemon.md` — reference doc, read-only
- `docs/work-orders/wo-010-socket-daemon.md` — reference doc, read-only

**Out of scope**:
- Multi-repo daemon (deferred per shared-daemon proposal §"Considered: multi-repo daemon")
- Worktree-scoped search (the shared-daemon proposal explicitly defers this)
- MCP transport
- Any change to the Rust engine, socket protocol shapes, or `.baba/` path conventions

## Implementation Specification

### 1. `resolveMainRoot(cwd: string): string`

From the session's CWD, resolve the main repository root (the canonical clone, not a worktree):

```
git -C <cwd> rev-parse --git-common-dir
```

- If the result ends with `/.git` → strip it → that's the repo root.
- If the result is a relative path without `/.git` suffix (e.g. for worktrees it returns `<mainRoot>/.git/worktrees/<name>`) → use `dirname()` to strip the trailing component, then strip `/.git`.
- Actually, `git rev-parse --git-common-dir` returns the **common** git dir: for a normal repo it returns `.git`; for a worktree it returns `<mainRoot>/.git` (the shared part). So the logic is: `result = run('git -C <cwd> rev-parse --git-common-dir')`, then `mainRoot = dirname(result)` (strip the `/.git`), then verify `mainRoot` is a directory. This handles both normal repos and worktrees uniformly.
- On any failure (git not found, not a repo, invalid output) → return `cwd` (today's behavior — the non-worktree case is unaffected).

### 2. `ensureDaemon(mainRoot: string): Promise<string>`

Ensure a `baba serve --repo <mainRoot> --socket <sock>` daemon is running and responsive. Returns the socket path.

**Liveness = (pid-alive) AND (socket-connects)**:
1. Read `<mainRoot>/.baba/daemon.pid`. If file exists, parse PID, check `kill(pid, 0)` (via `process.kill(pid, 0)` in Node — throws if not alive).
2. If PID alive, try `net.connect(sockPath)`. If connection succeeds within ~2s → daemon is alive, return socket path.
3. If either check fails → clean up stale files (unlink pid + socket if present) → spawn.

**Spawn**:
```
spawn(bin, ['serve', '--repo', mainRoot, '--socket', sockPath], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, BABA_EMBEDDER: embedderCmd() },
})
child.unref()
```
- `detached: true` + `unref()` → daemon survives extension/session exit.
- The binary and embedder resolve via the existing `resolveCoreBin()` and `embedderCmd()` (which use `BABA_ROOT` — the extension's real location — so they work regardless of session CWD).
- The daemon writes its own `daemon.pid` and `daemon.sock` (WO-010 responsibility).

**Wait for socket** (post-spawn):
- Poll for `<mainRoot>/.baba/daemon.sock` to appear (poll every ~500ms, up to ~30s).
- If socket appears → return socket path.
- If timeout → throw `Error("baba daemon failed to start within 30s")`.

**Race tolerance**: Two sessions may call `ensureDaemon` simultaneously. The first to `bind` wins; the loser's daemon gets `EADDRINUSE` and exits (WO-010 behavior: log + exit(0)). The loser's `ensureDaemon` then connects to the winner's socket (re-check liveness after spawn attempt). This is a retry loop: try-spawn → wait → check liveness → if still dead, try again (max ~2 spawn attempts).

### 3. Socket client

Replace the stdio `sendRequest`/`sendRequestOnce` with a Unix socket client.

**Protocol** (identical to stdio, per WO-010):
- Send: `{"type":"search","query":"...","top_k":N}\n`
- Receive (line-by-line until terminal): `{"type":"status","msg":"..."}\n` (zero or more) → `{"type":"results","results":[...]}\n` or `{"type":"error","msg":"..."}\n`

**Client lifecycle**:
- `daemonSocket: net.Socket | null` — one persistent connection per extension instance.
- `getSocket(sockPath)` — returns existing if connected, otherwise creates a new `net.connect(sockPath)` with `encoding: 'utf8'` + `readline` interface. On socket `close`/`error` → set `daemonSocket = null` (next request reconnects).
- `daemonRequest(req, sockPath)` — send request, read lines until terminal response. On connection error → reconnect once and retry. On `error` response → throw with message. On `results` → return results.

**Request serialization**: Same pattern as today (`requestQueue = prev.then(...)`) — one request at a time per extension instance. Different extension instances (different pi sessions) connect independently to the same daemon socket (WO-010 handles concurrent connections).

### 4. `session_shutdown` → no-op

The daemon is shared and detached — other sessions may still use it. `session_shutdown` does NOT kill the daemon. The daemon self-exits after `BABA_DAEMON_IDLE_SECS` of inactivity (WO-010, default 600s). Remove the `killChild()` call and the `session_shutdown` listener.

### 5. Tool description (scope clarity)

Update the `semantic_search` description to state explicitly:

> "Semantic code search over the main repository's docs and code (not your current worktree). Returns ranked chunks with path, heading, snippet, and relevance score."

This prevents agent confusion about what's indexed (main repo, not worktree edits).

### 6. Whitelist: `scout-code.md`

Add `semantic_search` to the `tools:` list in `~/.pi/agent/agents/scout-code.md`:

```
tools: read, grep, find, ls, bash, semantic_search
```

**Deliberately NOT added to `review-*` agents** — for a reviewer, the main-repo index is actively misleading (shows stale main-branch versions of files the changeset modifies). Reviewers keep `read`/`grep`/`rg`/`diff` which operate on the worktree's current state.

### 7. Remove dead code

After the refactor, remove:
- `child` variable + `requestQueue` (stdio-specific)
- `ensureChild(repoRoot)` (replaced by `ensureDaemon`)
- `killChild()` (no longer needed — daemon manages its own lifecycle)
- `sendRequest(req)` + `sendRequestOnce(req)` (replaced by `daemonRequest`)
- `BABA_ROOT` remains (still needed for `resolveCoreBin()` and `embedderCmd()`)

Keep:
- `resolveCoreBin()` — still resolves the binary path
- `embedderCmd()` — still resolves the embedder command (injected via BABA_EMBEDDER env var)
- `formatResults()` — unchanged

## Required test boundary

The extension is a pi extension (TypeScript) — the implementer cannot write automated tests for it (no test harness for pi extensions exists). Verification is **manual end-to-end**: spawn the daemon from a foreign CWD, connect, query, verify results. The test boundary is the real extension running in a real pi session.

## Behavior and failure matrix

- **Normal**: `resolveMainRoot(cwd)` → main repo root; `ensureDaemon` → daemon alive or spawned; socket query → results. *(success path)*
- **Worktree CWD**: session in a git worktree → `git-common-dir` → main repo root → daemon serves main repo index. *(core worktree scenario)*
- **Non-git CWD**: `git rev-parse` fails → fallback to cwd → daemon indexes that dir. *(non-git repo)*
- **Daemon not running**: `ensureDaemon` detects dead pid/missing socket → cleans up → spawns detached daemon → waits → connects. *(cold start)*
- **Daemon already running**: liveness checks pass → connects to existing socket. *(warm start, most common)*
- **Two sessions spawn simultaneously**: both call `ensureDaemon`; one wins `bind`, loser gets `EADDRINUSE` → exits; loser retries → connects to winner. *(race tolerance)*
- **Stale pid/socket after crash**: pid file exists but process dead → clean up → respawn. *(crash recovery)*
- **Socket disconnect mid-request**: `daemonRequest` detects connection error → reconnects once → retries request. *(reconnect)*
- **Daemon dies while idle**: next `daemonRequest` gets connection error → `ensureDaemon` re-checks liveness → respawns. *(self-healing)*
- **Empty query**: early return with error message. *(validation, unchanged from today)*
- **BABA_EMBEDDER not set**: extension injects it via `embedderCmd()` using `BABA_ROOT`. *(env propagation, unchanged)*
- **session_shutdown**: no-op — daemon persists for other sessions. *(shared lifecycle)*

## Representation-level checks

N/A — this is a TypeScript extension refactor; no IR or data structures to validate.

## Integration contract

- The extension speaks the exact JSON-line protocol defined in `core/src/serve.rs` (`Request`/`Response` types). No changes to the protocol shapes.
- Socket path convention: `<mainRoot>/.baba/daemon.sock`; pid: `<mainRoot>/.baba/daemon.pid`. This is the WO-010 contract; WO-014 consumes it.
- The daemon's `--repo` flag determines what gets indexed. The extension passes `resolveMainRoot(ctx.cwd)` which always returns the **main repo root** (not the session's worktree).
- The daemon self-exits after `BABA_DAEMON_IDLE_SECS` (default 600) of inactivity. The extension does NOT manage daemon lifecycle beyond spawning.
- `semantic_search` is exposed to `scout-code` agents only (via `tools:` frontmatter). Other agents with no `tools:` list (implement-pro, implement-flash, orchestrator) get all registered extension tools by default.

## Invariants

**Cross-file conventions**:
- `BABA_ROOT` resolves from the extension's **real** location (`realpathSync(fileURLToPath(import.meta.url))`) — not the session CWD. The binary + embedder always live in the baba repo, regardless of which repo the session is in.
- The extension must NOT change the daemon's protocol shapes (`Request`/`Response`), socket/pid path conventions, or any Rust code.
- `resolveMainRoot` is the ONLY place worktree/git-common-dir reasoning happens (engine-single-target invariant from shared-daemon proposal).

**Default values to preserve**:
- `top_k` default: 10 (unchanged)
- `BABA_EMBEDDER_IDLE_SECS`: unchanged (WO-003 default 60)
- `BABA_DAEMON_IDLE_SECS`: 600 (WO-010; extension does NOT set this — daemon reads it from env)
- Socket perms: 0600 (WO-010; extension does NOT set this — daemon handles it)

**Ordering assumptions**:
- `resolveMainRoot` runs before `ensureDaemon` (daemon needs the main repo path).
- `ensureDaemon` runs before `daemonRequest` (socket must exist).
- `ensureDaemon` may spawn a daemon that needs startup catch-up time — the socket wait handles this.

**Error handling conventions**:
- Connection errors → reconnect once → retry. If still fails → throw with descriptive message.
- `error` response from daemon → throw with message (surface to user).
- Spawn failure → throw with message (surface to user).
- `resolveMainRoot` failure → fallback to cwd (no error, graceful degradation).

**Unspecified invariants (implicit — why this is `implement-pro`)**:
- Exact reconnection behavior (number of retries, backoff) — implementer's choice; must not infinite-loop.
- Socket timeout values for connect/read — implementer's choice; must be reasonable (connect ~5s, read ~30s).
- Whether to pool/reuse the socket or create a new one per request — implementer's choice; persistent with reconnect is the intent.
- How to handle the daemon's stderr output (the detached daemon's stderr goes... nowhere? to a log?) — document the trade-off.

## Verification Criteria

**Entry points that must work**:
- `semantic_search` tool in a pi session returns results from the main repo index.
- From a git worktree CWD, `resolveMainRoot` returns the main repo root.
- From a non-git CWD, `resolveMainRoot` returns the CWD.
- `session_shutdown` does NOT kill the daemon.

**Input shapes that must be accepted**:
- Any CWD (normal repo, worktree, non-git directory).
- Any query string (same as today).

**Tests that must pass**:
- Manual end-to-end: spawn pi with baba extension from a non-baba CWD (e.g., tfd) → `semantic_search "test query"` → results from tfd's index.
- Verify daemon spawn: `ps aux | grep "baba serve"` shows the daemon process after first query.
- Verify shared daemon: two sessions → one `baba serve` process (visible in `ps`).
- Verify worktree: from a git worktree CWD → results come from the main repo index, not the worktree.

**Build requirements**:
- `npx tsc --noEmit` (or whatever the extension's build check is) passes.
- No new npm dependencies.

## Structural Risks

- [ ] **Route/path correctness**: `resolveMainRoot` returns the **main repo root**, not the worktree root or the `.git` path.
- [ ] **Input validation scope**: Empty queries rejected early; socket connection errors handled gracefully.
- [ ] **No unrequested changes**: No Rust core, embedder, store, or index changes. No MCP. No multi-repo.
- [ ] **Build config untouched**: No new npm dependencies. No tsconfig changes.
- [ ] **No unsolicited features**: No worktree-scoped search, no daemon status endpoint, no config reloading.
- [ ] **Recovery logic**: Stale pid/socket cleanup; reconnect-on-failure; race tolerance on concurrent spawn.
- [ ] **Process lifecycle**: `detached: true` + `unref()` ensures daemon survives extension exit; `session_shutdown` does NOT kill the daemon.

## Context

**Prior work orders completed**:
- WO-010 (socket daemon, merged `dc6c79a`) — `baba serve --socket` with Unix socket transport, reply-channel refactor, idle self-exit, pid/socket lifecycle. The daemon side is DONE; this WO wires the client side.
- WO-011 (config discovery, merged `0ac6185`/`2d3259f`) — `baba.json` at repo root, `effective_extensions()`. The daemon reads config; this WO doesn't change config.
- WO-012 (config extensibility, merged `9fbc497`) — two-tier config, external chunkers, decoupled cases. This WO doesn't change config.
- WO-013 (language grammars, merged `8f58313`) — 10 tree-sitter grammars, `LANGUAGES` expanded to 12. The daemon indexes all 12 langs; this WO doesn't change indexing.

**Upcoming**:
- None currently planned. This completes the shared-daemon milestone.

**Relevant decisions from `docs/proposals/shared-daemon.md`**:
- Engine stays single-target / repo-agnostic — ALL worktree/git-common-dir reasoning lives in the extension (`resolveMainRoot`). The daemon indexes precisely the dir it's given.
- Multi-repo deferred — one daemon per repo for v1.
- Socket reuses the exact stdio protocol (additive transport).
- Detached spawn via Node (`detached: true`, `stdio: 'ignore'`, `unref()`) — no Rust-side double-fork.
- `semantic_search` whitelisted to `scout-code` ONLY (not `review-*` — stale-index correctness risk).

**Known prior-session state**:
- A pre-WO-010 stdio daemon may still be running: PID 17674 = `baba serve --repo /Users/scott/Developer/tfd` (old binary). `ensureDaemon` will detect the stale pid/socket and respawn with the new socket binary. Do NOT manually kill; `ensureDaemon` handles it.
- The extension is currently symlinked at `~/.pi/agent/extensions/baba` → `extension/src/index.ts`. After this WO, the symlink still works (same file path).
