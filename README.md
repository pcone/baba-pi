# baba-pi

pi extension for [baba](https://github.com/nichochar/baba) — semantic code search over your docs and code.

Exposes a `semantic_search` tool to the LLM that queries a baba daemon over a Unix socket. All pi sessions (orchestrator + subagents) share one daemon per main repository.

## Setup

### 1. Install the baba engine

Clone and build the [baba engine repo](https://github.com/nichochar/baba):

```bash
git clone https://github.com/nichochar/baba ~/Developer/baba
cd ~/Developer/baba
cargo build --manifest-path core/Cargo.toml
```

### 2. Install the extension

```bash
ln -s ~/Developer/baba-pi ~/.pi/agent/extensions/baba
```

### 3. Configure

Set `BABA_HOME` so the extension can find the engine:

```bash
export BABA_HOME=~/Developer/baba
```

Or in your shell profile (`~/.zshrc`, `~/.bashrc`).

**Alternative** (if `baba` is on `$PATH`):
- The extension auto-detects the engine root from the binary location.
- For the embedder, set `BABA_EMBEDDER` explicitly if `BABA_HOME` is not set.

| Env var | Default | Description |
|---|---|---|
| `BABA_HOME` | auto-detect from PATH | Path to the baba engine repo |
| `BABA_BIN` | `$BABA_HOME/core/target/debug/baba` | Override binary path |
| `BABA_EMBEDDER` | `$BABA_HOME/embedder/.venv/bin/python server.py` | Override embedder command |

### 4. Index your repo

Before first use, build the search index:

```bash
cd ~/Developer/baba
cargo run --manifest-path core/Cargo.toml -- index --repo /path/to/your/repo
```

The index is stored in `.baba/` at the repo root.

## Usage

Start a pi session in any indexed repo:

```bash
cd /path/to/your/repo
pi
```

The LLM can now use `semantic_search` to find relevant code and docs:

```
> How does the type system work?
```

## Architecture

- **Engine** (`baba` repo): Rust binary + Python CoreML embedder. Indexes docs and code, serves queries over Unix socket.
- **Extension** (`baba-pi` repo): Thin TypeScript client. Resolves the main repo from any CWD (worktree-aware), spawns/connects to the daemon, formats results.
- **Daemon lifecycle**: One detached `baba serve --socket` per repo clone. Self-exits after 10 minutes of inactivity. Spawned on demand by the extension.

## Development

The extension is a single TypeScript file (`src/index.ts`). pi loads it directly (no build step). To test:

```bash
pi -e ./src/index.ts
```
