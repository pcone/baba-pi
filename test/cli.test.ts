/**
 * Rows for `bin/baba-search.ts` — the one-query CLI.
 *
 * Every row runs the real CLI as a child process (`bun bin/baba-search.ts …`),
 * never an internal helper, so the argv parsing, the cwd resolution, the
 * daemon connect and the exit status are all under test.
 *
 * The daemon is fake and lives in a temp repo: a unix socket at
 * `<repo>/.baba/daemon.sock` answering canned JSON lines. `ensureDaemon`
 * decides liveness from `<repo>/.baba/daemon.pid` plus a connect, so the
 * fixture writes this process's pid there (alive) — without it the client
 * unlinks the fake socket and spawns the real core. `BABA_BIN` must name an
 * existing file for the same reason: `ensureDaemon` checks it before the
 * liveness probe.
 *
 * Run: bun test test/cli.test.ts
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "..", "bin", "baba-search.ts");

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, {
		cwd,
		env: GIT_ENV,
		stdio: ["ignore", "ignore", "ignore"],
		timeout: 30_000,
	});
}

type Harness = {
	repo: string;
	/** Lines the fake daemon received, in order. */
	received: string[];
	cleanup: () => Promise<void>;
};

/**
 * A temp git repo whose `.baba` holds a fake daemon: live pid file, and a
 * socket that answers each request line with `reply(line)`.
 */
async function fakeRepo(
	prefix: string,
	reply: (line: string) => string[],
): Promise<Harness> {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	git(repo, "init", "-q");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-q", "-m", "init");

	const baba = join(repo, ".baba");
	mkdirSync(baba);
	writeFileSync(join(baba, "daemon.pid"), `${process.pid}\n`);

	const received: string[] = [];
	const sockets: Socket[] = [];
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
				sock.write(reply(line).map((r) => r + "\n").join(""));
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

/** Run the CLI as a child process, from `cwd`, with `env` overrides. */
function runCli(
	cwd: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<Run> {
	return new Promise((res, rej) => {
		const child = spawn(process.execPath, [CLI, ...args], {
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
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			rej(new Error(`baba-search did not exit; stdout=${stdout} stderr=${stderr}`));
		}, 30_000);
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

const ONE_RESULT = {
	type: "results",
	results: [
		{
			source_type: "doc",
			source_path: "docs/a.md",
			heading_path: "Intro",
			score: 0.876,
			text: "hello world",
		},
	],
};
const ONE_RESULT_LINE = JSON.stringify(ONE_RESULT);
const ONE_RESULT_TEXT = "1. [0.876] docs/a.md — Intro\n   hello world";

describe("baba-search", () => {
	it("prints ranked results on stdout and nothing else", async () => {
		// Also pins the framing: one request line out, `formatResults` verbatim
		// on stdout, no chatter — stdout is the pipeable surface.
		const h = await fakeRepo("baba-cli-ok-", () => [ONE_RESULT_LINE]);
		try {
			const run = await runCli(h.repo, ["hello world"], {
				BABA_BIN: fakeBin(dirname(h.repo)),
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

	it("sends -k as top_k", async () => {
		const h = await fakeRepo("baba-cli-k-", () => [ONE_RESULT_LINE]);
		try {
			const run = await runCli(h.repo, ["hello world", "-k", "3"], {
				BABA_BIN: fakeBin(dirname(h.repo)),
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
				BABA_BIN: fakeBin(dirname(h.repo)),
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
				BABA_BIN: fakeBin(dirname(h.repo)),
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
				BABA_BIN: fakeBin(dirname(h.repo)),
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
				BABA_BIN: fakeBin(dirname(h.repo)),
			});
			expect(run.code).toBe(2);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain('unknown option "-x"');
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
			expect(run.stderr).toContain("is not inside a git repository");
			expect(existsSync(join(dir, ".baba"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits 1 with the daemon's message on an error response", async () => {
		const h = await fakeRepo("baba-cli-error-", () => [
			JSON.stringify({ type: "error", msg: "index missing" }),
		]);
		try {
			const run = await runCli(h.repo, ["hello world"], {
				BABA_BIN: fakeBin(dirname(h.repo)),
			});
			expect(run.code).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain("baba error: index missing");
		} finally {
			await h.cleanup();
		}
	});
});
