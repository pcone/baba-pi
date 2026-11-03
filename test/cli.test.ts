/**
 * Rows for `bin/baba-search.ts` — the one-query CLI.
 *
 * Every row runs the real CLI as a child process (`bun bin/baba-search.ts …`,
 * and one row by executing the file itself), never an internal helper, so the
 * argv parsing, the cwd resolution, the daemon connect and the exit status are
 * all under test.
 *
 * The daemon is fake and lives in a temp repo: a unix socket at
 * `<repo>/.baba/daemon.sock` answering canned JSON lines. `ensureDaemon`
 * decides liveness from `<repo>/.baba/daemon.pid` plus a connect, so the
 * fixture writes this process's pid there (alive) — without it the client
 * unlinks the fake socket and spawns the real core. `BABA_BIN` must name an
 * existing file for the same reason: `ensureDaemon` checks it before the
 * liveness probe.
 *
 * The fixture therefore covers warm runs only; the rows that need a failure
 * reach it without a spawn (a missing binary, a daemon that hangs up), which
 * is why neither of them waits for `DAEMON_START_TIMEOUT_MS`.
 *
 * Run: bun test test/cli.test.ts
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	fakeEnv,
	fakeServeBin,
	killSpawnedDaemon,
	ONE_RESULT_LINE,
	ONE_RESULT_TEXT,
} from "./support/fake-daemon.ts";
import { tempRepo } from "./support/repo.ts";

const CLI = resolve(import.meta.dir, "..", "bin", "baba-search.ts");

type Harness = {
	repo: string;
	/** Lines the fake daemon received, in order. */
	received: string[];
	cleanup: () => Promise<void>;
};

/**
 * A temp git repo whose `.baba` holds a fake daemon: live pid file, and a
 * socket that answers each request line with `reply(line)`. A null reply
 * hangs up instead, which is how the retry-exhausted row fails fast.
 */
async function fakeRepo(
	prefix: string,
	reply: (line: string, n: number) => string[] | null,
): Promise<Harness> {
	const repo = tempRepo(prefix);

	const baba = join(repo, ".baba");
	mkdirSync(baba);
	writeFileSync(join(baba, "daemon.pid"), `${process.pid}\n`);

	const received: string[] = [];
	const sockets: Socket[] = [];
	let n = 0;
	const server = createServer((sock) => {
		sockets.push(sock);
		sock.setEncoding("utf8");
		let buf = "";
		sock.on("data", (chunk: string) => {
			buf += chunk;
			let idx = buf.indexOf("\n");
			while (idx >= 0) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				received.push(line);
				const replies = reply(line, n++);
				if (replies === null) sock.destroy();
				else sock.write(replies.map((r) => r + "\n").join(""));
				idx = buf.indexOf("\n");
			}
		});
	});
	await new Promise<void>((res) => server.listen(join(baba, "daemon.sock"), res));

	return {
		repo,
		received,
		cleanup: async () => {
			for (const s of sockets) s.destroy();
			await new Promise<void>((res) => server.close(() => res()));
			rmSync(repo, { recursive: true, force: true });
		},
	};
}

/** `BABA_BIN` for the child: must exist, and never actually runs. */
function fakeBin(dir: string): string {
	const bin = join(dir, "fake-baba");
	writeFileSync(bin, "#!/bin/sh\nexit 1\n");
	chmodSync(bin, 0o755);
	return bin;
}

type Run = { code: number | null; stdout: string; stderr: string };

function collect(
	command: string,
	args: string[],
	cwd: string,
	env: Record<string, string>,
): Promise<Run> {
	return new Promise((res, rej) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (c: string) => {
			stdout += c;
		});
		child.stderr.setEncoding("utf8").on("data", (c: string) => {
			stderr += c;
		});
		// Under bun's 5s per-test timeout, so a row that wrongly reaches a
		// spawn reds on this message rather than as an opaque test timeout.
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			rej(new Error(`baba-search did not exit; stdout=${stdout} stderr=${stderr}`));
		}, 4000);
		child.on("error", (err) => {
			clearTimeout(timer);
			rej(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			res({ code, stdout, stderr });
		});
	});
}

/** Run the CLI as a child process, from `cwd`, with `env` overrides. */
function runCli(
	cwd: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<Run> {
	return collect(process.execPath, [CLI, ...args], cwd, env);
}

/** Execute the CLI file itself, the way the skill documents it. */
function runCliDirect(
	cwd: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<Run> {
	return collect(CLI, args, cwd, env);
}



describe("baba-search", () => {
	it("prints ranked results on stdout and nothing else", async () => {
		// Also pins the framing: one request line out, `formatResults` verbatim
		// on stdout, no chatter — stdout is the pipeable surface.
		const h = await fakeRepo("baba-cli-ok-", () => [ONE_RESULT_LINE]);
		try {
			const run = await runCli(h.repo, ["hello world"], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(0);
			expect(run.stdout).toBe(`${ONE_RESULT_TEXT}\n`);
			expect(run.stderr).toBe("");
			expect(h.received).toEqual([
				'{"type":"search","query":"hello world","top_k":10}',
			]);
		} finally {
			await h.cleanup();
		}
	});

	it("runs when the file is executed directly", async () => {
		// The skill's only invocation: `#!/usr/bin/env bun` plus the exec bit.
		// `bun <script>` would pass without either.
		const h = await fakeRepo("baba-cli-exec-", () => [ONE_RESULT_LINE]);
		try {
			const run = await runCliDirect(h.repo, ["hello world"], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(0);
			expect(run.stdout).toBe(`${ONE_RESULT_TEXT}\n`);
			expect(run.stderr).toBe("");
		} finally {
			await h.cleanup();
		}
	});

	it("sends -k as top_k", async () => {
		const h = await fakeRepo("baba-cli-k-", () => [ONE_RESULT_LINE]);
		try {
			const run = await runCli(h.repo, ["hello world", "-k", "3"], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(0);
			expect(h.received).toEqual([
				'{"type":"search","query":"hello world","top_k":3}',
			]);
		} finally {
			await h.cleanup();
		}
	});

	it("resolves the repo from a subdirectory of the checkout", async () => {
		// Resolving from the script's own directory instead of the cwd lands on
		// this repo's root, which has no daemon: the CLI would try to spawn one
		// and fail, so this row is the cwd-resolution pin.
		const h = await fakeRepo("baba-cli-sub-", () => [ONE_RESULT_LINE]);
		const sub = join(h.repo, "deep", "nested");
		try {
			mkdirSync(sub, { recursive: true });
			const run = await runCli(sub, ["hello world"], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(0);
			expect(run.stdout).toBe(`${ONE_RESULT_TEXT}\n`);
		} finally {
			await h.cleanup();
		}
	});

	it("keeps status lines on stderr", async () => {
		// The daemon sends progress before the terminal response; a caller piping
		// stdout must not receive it.
		const h = await fakeRepo("baba-cli-status-", () => [
			JSON.stringify({ type: "status", msg: "indexing..." }),
			ONE_RESULT_LINE,
		]);
		try {
			const run = await runCli(h.repo, ["hello world"], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(0);
			expect(run.stdout).toBe(`${ONE_RESULT_TEXT}\n`);
			expect(run.stderr).toBe("[baba] indexing...\n");
		} finally {
			await h.cleanup();
		}
	});

	it("prints usage to stderr and exits 2 with no query", async () => {
		const h = await fakeRepo("baba-cli-noarg-", () => [ONE_RESULT_LINE]);
		try {
			const run = await runCli(h.repo, [], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(2);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain(
				'usage: baba-search "<query>" [-k N]',
			);
			// No request went out: a usage error is not a default query.
			expect(h.received).toEqual([]);
		} finally {
			await h.cleanup();
		}
	});

	it("exits 2 on an unknown option", async () => {
		const h = await fakeRepo("baba-cli-opt-", () => [ONE_RESULT_LINE]);
		try {
			const run = await runCli(h.repo, ["hello", "-x"], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(2);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain('unknown option "-x"');
			expect(h.received).toEqual([]);
		} finally {
			await h.cleanup();
		}
	});

	it("exits 2 when -k is not a positive integer", async () => {
		const h = await fakeRepo("baba-cli-badk-", () => [ONE_RESULT_LINE]);
		try {
			for (const args of [
				["hello", "-k", "abc"],
				["hello", "-k", "0"],
				["hello", "-k"],
			]) {
				const run = await runCli(h.repo, args, {
					BABA_BIN: fakeBin(join(h.repo, ".baba")),
				});
				expect(run.code).toBe(2);
				expect(run.stdout).toBe("");
				expect(run.stderr).toContain("-k needs a positive integer");
			}
			expect(h.received).toEqual([]);
		} finally {
			await h.cleanup();
		}
	});

	it("exits 2 on an empty query", async () => {
		const h = await fakeRepo("baba-cli-empty-", () => [ONE_RESULT_LINE]);
		try {
			const run = await runCli(h.repo, ["   "], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(2);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("empty query");
			expect(h.received).toEqual([]);
		} finally {
			await h.cleanup();
		}
	});

	it("exits 2 on a second positional", async () => {
		const h = await fakeRepo("baba-cli-two-", () => [ONE_RESULT_LINE]);
		try {
			const run = await runCli(h.repo, ["one", "two"], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(2);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("one query per call");
			expect(h.received).toEqual([]);
		} finally {
			await h.cleanup();
		}
	});

	it("exits 1 with the reason when the cwd is not in a repo", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baba-cli-norepo-"));
		try {
			const run = await runCli(dir, ["hello world"], {
				BABA_BIN: fakeBin(dir),
			});
			expect(run.code).toBe(1);
			expect(run.stdout).toBe("");
			// Exact, so a git `fatal:` line leaking through the client's
			// execFileSync would red this row: stderr is the CLI's own message.
			expect(run.stderr).toBe(
				`baba-search: ${realpathSync(dir)} is not inside a git repository, or git could not answer — baba indexes a repo's main checkout, so run this from one (or from a worktree of one)\n`,
			);
			expect(existsSync(join(dir, ".baba"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits 1 naming the reason when the baba binary is missing", async () => {
		// The "no daemon" arm of the contract. No `.baba` and no usable binary,
		// so `ensureDaemon` throws before any spawn or poll.
		const repo = tempRepo("baba-cli-nobin-");
		try {
			const run = await runCli(repo, ["hello world"], {
				BABA_BIN: join(repo, "no-such-baba"),
			});
			expect(run.code).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("baba binary not found at");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("exits 1 when the daemon hangs up on every attempt", async () => {
		// Retry-exhausted, the realistic "daemon died" path: the client retries
		// once, then rejects, and the CLI reports it instead of printing nothing.
		const h = await fakeRepo("baba-cli-hangup-", () => null);
		try {
			const run = await runCli(h.repo, ["hello world"], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("closed the connection");
			expect(h.received).toHaveLength(2);
		} finally {
			await h.cleanup();
		}
	});

	it("prints the daemon log's startup lines on stderr while it waits", async () => {
		// The daemon is spawned by the CLI itself: its stderr is the log, and the
		// lines reach the CLI's stderr before the result on stdout.
		const repo = tempRepo("baba-cli-log-");
		const binDir = mkdtempSync(join(tmpdir(), "baba-cli-logbin-"));
		try {
			const run = await runCli(repo, ["hello world"], {
				BABA_BIN: fakeServeBin(binDir),
				...fakeEnv({
					lines: [[0, "baba: startup 1/2"]],
					bindMs: 600,
					reply: [ONE_RESULT_LINE],
				}),
			});
			expect(run.code).toBe(0);
			expect(run.stdout).toBe(`${ONE_RESULT_TEXT}\n`);
			expect(run.stderr).toBe("[baba] baba: startup 1/2\n");
		} finally {
			killSpawnedDaemon(repo);
			rmSync(repo, { recursive: true, force: true });
			rmSync(binDir, { recursive: true, force: true });
		}
	});

	it("exits 1 with the daemon's message on an error response", async () => {
		const h = await fakeRepo("baba-cli-error-", () => [
			JSON.stringify({ type: "error", msg: "index missing" }),
		]);
		try {
			const run = await runCli(h.repo, ["hello world"], {
				BABA_BIN: fakeBin(join(h.repo, ".baba")),
			});
			expect(run.code).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("baba error: index missing");
		} finally {
			await h.cleanup();
		}
	});
});
