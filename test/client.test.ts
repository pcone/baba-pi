/**
 * Characterization rows for the baba daemon client.
 *
 * The client was extracted out of `src/index.ts` into `src/client.ts` without
 * changing behaviour; these rows pin what the extract preserves.
 *
 *   1. `resolveMainRoot` / `findMainRoot`: linked worktree, a subdirectory of
 *      one, the main checkout, a subdirectory of the main checkout (the only
 *      shape where `--git-common-dir` comes back relative, so it pins the
 *      `resolve(cwd, …)` composition), and outside a repo at all.
 *   2. The socket protocol: one JSON line out, one parsed reply in, `status`
 *      lines accumulated onto the terminal response, and the reconnect-once
 *      retry.
 *   3. `formatResults` over zero, one and three results, byte-for-byte.
 *
 * Run: bun test test/client.test.ts
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	daemonRequest,
	findMainRoot,
	formatResults,
	resolveMainRoot,
	type SearchResult,
	type ServeRequest,
} from "../src/client.ts";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: GIT_ENV,
		encoding: "utf8",
		// The outside-a-repo rows make git fail on purpose; its stderr would
		// otherwise land in the middle of the test output.
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 30_000,
	}).trim();
}

/** A committed git repo, and a linked worktree of it, in a fresh temp dir. */
function repoWithWorktree(prefix: string) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const main = join(dir, "main");
	const linked = join(dir, "linked");
	mkdirSync(main);
	git(main, "init", "-q");
	writeFileSync(join(main, "a.txt"), "a\n");
	git(main, "add", "a.txt");
	git(main, "commit", "-q", "-m", "init");
	git(main, "worktree", "add", "-q", linked, "-b", "wt");
	return {
		dir,
		main,
		linked,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

// ── 1. Repo resolution across worktrees ─────────────────────────────

describe("resolveMainRoot", () => {
	// git reports the realpath of --git-common-dir while mkdtemp hands back the
	// /var/folders spelling of the same directory, so both sides are normalised:
	// the rows pin which directory wins, not how it is spelled.
	it("returns the main checkout from a linked worktree", () => {
		const { main, linked, cleanup } = repoWithWorktree("baba-client-wt-");
		try {
			expect(realpathSync(resolveMainRoot(linked))).toBe(realpathSync(main));
		} finally {
			cleanup();
		}
	});

	it("returns the main checkout from a subdirectory of the worktree", () => {
		const { main, linked, cleanup } = repoWithWorktree("baba-client-wt-sub-");
		const nested = join(linked, "deep", "nested");
		try {
			mkdirSync(nested, { recursive: true });
			expect(realpathSync(resolveMainRoot(nested))).toBe(realpathSync(main));
		} finally {
			cleanup();
		}
	});

	it("returns the main checkout from a subdirectory of the main checkout", () => {
		// The only shape where --git-common-dir is relative ("../.git"): dropping
		// the cwd from `resolve(cwd, dirname(gitCommonDir))` reds this row and
		// neither worktree row.
		const { main, cleanup } = repoWithWorktree("baba-client-main-sub-");
		const sub = join(main, "sub", "deeper");
		try {
			mkdirSync(sub, { recursive: true });
			expect(realpathSync(resolveMainRoot(sub))).toBe(realpathSync(main));
		} finally {
			cleanup();
		}
	});

	it("falls back to the cwd outside any repo", () => {
		// The extension's documented fallback: a git failure is not an error for
		// the tool, it just means no worktree indirection.
		const dir = mkdtempSync(join(tmpdir(), "baba-client-norepo-"));
		try {
			expect(resolveMainRoot(dir)).toBe(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("findMainRoot", () => {
	it("returns null outside any repo", () => {
		// The CLI's exit-1 arm branches on this: a null is the only evidence that
		// no daemon can be resolved, so it must not be papered over with the cwd.
		const dir = mkdtempSync(join(tmpdir(), "baba-client-find-norepo-"));
		try {
			expect(findMainRoot(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("agrees with resolveMainRoot inside a worktree", () => {
		const { main, linked, cleanup } = repoWithWorktree("baba-client-find-wt-");
		try {
			expect(realpathSync(findMainRoot(linked)!)).toBe(realpathSync(main));
		} finally {
			cleanup();
		}
	});
});

// ── 2. Protocol framing ─────────────────────────────────────────────

type FakeDaemon = {
	sockPath: string;
	sockets: Socket[];
	close: () => Promise<void>;
};

/**
 * A fake daemon at `sockPath`. `onRequest` returns the lines to write back (or
 * nothing, to hang up silently).
 */
async function fakeDaemon(
	sockPath: string,
	onRequest: (line: string, n: number) => string[] | null,
): Promise<FakeDaemon> {
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
				const replies = onRequest(line, n++);
				if (replies === null) sock.destroy();
				else sock.write(replies.map((r) => r + "\n").join(""));
				idx = buf.indexOf("\n");
			}
		});
	});
	await new Promise<void>((res) => server.listen(sockPath, res));
	return {
		sockPath,
		sockets,
		close: async () => {
			for (const s of sockets) s.destroy();
			await new Promise<void>((res) => server.close(() => res()));
			// The client caches one socket in module scope; `server.close()`
			// guarantees its socket is gone by here, so this settle is belt and
			// braces. The retry row is the real detector (a reused live socket
			// arrives with one line, a reused dead one burns the retry) and reds
			// either way.
			await new Promise((res) => setTimeout(res, 50));
		},
	};
}

const RESULTS_LINE = JSON.stringify({
	type: "results",
	results: [
		{
			source_type: "doc",
			source_path: "docs/a.md",
			heading_path: "Intro",
			score: 0.5,
			text: "hello",
		},
	],
});

describe("daemonRequest over a fake daemon socket", () => {
	it("sends exactly one JSON line and parses the canned reply", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baba-client-sock-"));
		const received: string[] = [];
		const daemon = await fakeDaemon(join(dir, "daemon.sock"), (line) => {
			received.push(line);
			return [
				JSON.stringify({ type: "status", msg: "indexing..." }),
				RESULTS_LINE,
			];
		});
		try {
			const request: ServeRequest = {
				type: "search",
				query: "hello world",
				top_k: 3,
			};
			const response = await daemonRequest(request, daemon.sockPath);

			// Exactly one line, and it is the request verbatim. A chunked write is
			// not observably different at a socket boundary, so "split the write"
			// here means two lines.
			expect(received).toEqual([
				'{"type":"search","query":"hello world","top_k":3}',
			]);
			expect(response.type).toBe("results");
			if (response.type === "results") {
				expect(response.results).toHaveLength(1);
				expect(response.results[0].source_path).toBe("docs/a.md");
				expect(response.results[0].score).toBe(0.5);
			}
			expect((response as { statuses?: string[] }).statuses).toEqual([
				"indexing...",
			]);
		} finally {
			await daemon.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reconnects once and retries when the daemon hangs up without answering", async () => {
		const dir = mkdtempSync(join(tmpdir(), "baba-client-retry-"));
		const received: string[] = [];
		let hungUp = false;
		const daemon = await fakeDaemon(join(dir, "daemon.sock"), (line) => {
			received.push(line);
			if (!hungUp) {
				hungUp = true;
				return null; // first attempt: close without a reply
			}
			return [RESULTS_LINE];
		});
		try {
			const response = await daemonRequest(
				{ type: "search", query: "retry", top_k: 1 },
				daemon.sockPath,
			);
			// Both connections carried the request; the second one answered.
			expect(received).toHaveLength(2);
			expect(received[0]).toBe(received[1]);
			expect(response.type).toBe("results");
		} finally {
			await daemon.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── 3. Formatting ───────────────────────────────────────────────────

describe("formatResults", () => {
	it("renders zero results", () => {
		expect(formatResults([])).toBe("No results found.");
	});

	it("renders one result", () => {
		const one: SearchResult[] = [
			{
				source_type: "doc",
				source_path: "docs/a.md",
				heading_path: "Intro",
				score: 0.876,
				text: "hello world",
			},
		];
		expect(formatResults(one)).toBe(
			"1. [0.876] docs/a.md — Intro\n   hello world",
		);
	});

	it("renders three results, including one without a heading", () => {
		const three: SearchResult[] = [
			{
				source_type: "doc",
				source_path: "a.md",
				heading_path: "A",
				score: 1,
				text: "first",
			},
			{
				source_type: "code",
				source_path: "b.md",
				heading_path: "",
				score: 0.5,
				text: "second",
			},
			{
				source_type: "doc",
				source_path: "c.md",
				heading_path: "C / C1",
				score: 0.1234,
				text: "third",
			},
		];
		expect(formatResults(three)).toBe(
			"1. [1.000] a.md — A\n" +
				"   first\n" +
				"\n" +
				"2. [0.500] b.md\n" +
				"   second\n" +
				"\n" +
				"3. [0.123] c.md — C / C1\n" +
				"   third",
		);
	});
});
