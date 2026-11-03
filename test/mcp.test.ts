/**
 * Rows for `bin/baba-mcp.ts`, the stdio MCP server.
 *
 * Each row starts the server as a child process and speaks MCP to it with the
 * SDK client (`test/support/mcp-session.ts`). The daemon is the fake from
 * `test/support/fake-serve.ts`, spawned by the server itself, so the rows
 * exercise the real client path. Rows are named `row N:` after the work order.
 *
 * Run: bun test test/mcp.test.ts
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fakeEnv,
	fakeServeBin,
	killSpawnedDaemon,
	ONE_RESULT_LINE,
	ONE_RESULT_TEXT,
} from "./support/fake-daemon.ts";
import {
	frameProblems,
	openSession,
	SERVER,
	type McpSession,
} from "./support/mcp-session.ts";
import { git, tempRepo } from "./support/repo.ts";

const CLI = join(import.meta.dir, "..", "bin", "baba-search.ts");
const SLOW = 30_000;

/** Every directory a row makes; removed, and any daemon it spawned stopped, after each row. */
const made: string[] = [];
const repos: string[] = [];

afterEach(() => {
	for (const repo of repos.splice(0)) killSpawnedDaemon(repo);
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

function repo(prefix: string): string {
	const r = tempRepo(prefix);
	made.push(r);
	repos.push(r);
	return r;
}

/** `BABA_BIN` for the server, plus the fake daemon's behaviour. */
function daemonEnv(opts: Parameters<typeof fakeEnv>[0] = {}): Record<string, string> {
	return { BABA_BIN: fakeServeBin(), ...fakeEnv(opts) };
}

async function closeSession(s: McpSession): Promise<void> {
	await s.close();
}

type Progress = { progress: number; total?: number; message?: string };

describe("baba-mcp", () => {
	it("row 1: tools/list returns exactly one tool, search, with query and k", async () => {
		const s = await openSession({ cwd: scratch("baba-mcp-list-") });
		try {
			const { tools } = await s.client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["search"]);
			expect(tools[0].inputSchema).toEqual({
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Natural-language search query",
					},
					k: {
						type: "integer",
						minimum: 1,
						description: "Number of results (default 10)",
					},
				},
				required: ["query"],
				additionalProperties: false,
			});
			expect(frameProblems(s.transport)).toEqual([]);
		} finally {
			await closeSession(s);
		}
	});

	it("row 2: tools/call returns the text the CLI prints for the same daemon answer", async () => {
		const dir = repo("baba-mcp-text-");
		const env = daemonEnv({ reply: [ONE_RESULT_LINE] });
		const s = await openSession({ cwd: dir, env });
		try {
			const res = await s.client.callTool({
				name: "search",
				arguments: { query: "hello world" },
			});
			expect(res.isError).toBeFalsy();
			const text = (res.content as { text: string }[])[0].text;
			expect(text).toBe(`${ONE_RESULT_TEXT}\n`);
			const cliStdout = execFileSync(process.execPath, [CLI, "hello world"], {
				cwd: dir,
				env: { ...process.env, ...env },
				encoding: "utf8",
			});
			expect(text).toBe(cliStdout);
			expect(frameProblems(s.transport)).toEqual([]);
		} finally {
			await closeSession(s);
		}
	}, SLOW);

	it("row 3: starting the server and listing tools spawns no daemon", async () => {
		const dir = repo("baba-mcp-idle-");
		const mark = join(scratch("baba-mcp-mark-"), "starts");
		const s = await openSession({
			cwd: dir,
			env: daemonEnv({ reply: [ONE_RESULT_LINE], mark }),
		});
		try {
			await s.client.listTools();
			expect(existsSync(mark)).toBe(false);
			expect(existsSync(join(dir, ".baba"))).toBe(false);
			await s.client.callTool({ name: "search", arguments: { query: "q" } });
			expect(existsSync(mark)).toBe(true);
		} finally {
			await closeSession(s);
		}
	}, SLOW);

	it("row 4: a call outside a repo is isError naming the cause, and tools/list still answers", async () => {
		const dir = scratch("baba-mcp-norepo-");
		const s = await openSession({ cwd: dir });
		try {
			const res = await s.client.callTool({
				name: "search",
				arguments: { query: "q" },
			});
			expect(res.isError).toBe(true);
			const text = (res.content as { text: string }[])[0].text;
			expect(text).toContain(
				`${realpathSync(dir)} is not inside a git repository`,
			);
			const { tools } = await s.client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["search"]);
			expect(frameProblems(s.transport)).toEqual([]);
		} finally {
			await closeSession(s);
		}
	});

	it("row 5: with a progress token, daemon log lines arrive as progress before the result", async () => {
		// The daemon is not up for 1.2 s, so the client waits and tails its log.
		// Each log line becomes one progress notification (row 7, server half).
		const dir = repo("baba-mcp-progress-");
		const s = await openSession({
			cwd: dir,
			env: daemonEnv({
				lines: [
					[0, "baba: startup 1/2"],
					[300, "baba: startup 2/2"],
				],
				bindMs: 1200,
				reply: [ONE_RESULT_LINE],
			}),
		});
		try {
			const progress: Progress[] = [];
			const res = await s.client.callTool(
				{ name: "search", arguments: { query: "hello world" } },
				undefined,
				{ onprogress: (p) => progress.push(p) },
			);
			expect(res.isError).toBeFalsy();
			expect(progress.map((p) => p.message)).toEqual([
				"baba: startup 1/2",
				"baba: startup 2/2",
			]);
			expect(progress.map((p) => p.progress)).toEqual([1, 2]);

			const frames = s.transport.messages;
			const progressAt = frames.findIndex(
				(m) => "method" in m && m.method === "notifications/progress",
			);
			const resultAt = frames.findIndex(
				(m) => "result" in m && "content" in (m.result as object),
			);
			expect(progressAt).toBeGreaterThanOrEqual(0);
			expect(progressAt).toBeLessThan(resultAt);
			expect(frameProblems(s.transport)).toEqual([]);
		} finally {
			await closeSession(s);
		}
	}, SLOW);

	it("row 6: every stdout line across a session is a JSON-RPC frame", async () => {
		const dir = repo("baba-mcp-frames-");
		const s = await openSession({
			cwd: dir,
			env: daemonEnv({
				lines: [[0, "baba: startup"]],
				bindMs: 800,
				reply: [ONE_RESULT_LINE],
			}),
		});
		try {
			await s.client.listTools();
			await s.client.callTool(
				{ name: "search", arguments: { query: "cold" } },
				undefined,
				{ onprogress: () => {} },
			);
			const bad = await s.client.callTool({
				name: "search",
				arguments: { query: "q", k: 0 },
			});
			expect(bad.isError).toBe(true);
			await s.client.callTool({ name: "search", arguments: { query: "warm" } });

			expect(s.transport.rawLines.length).toBeGreaterThan(0);
			expect(frameProblems(s.transport)).toEqual([]);
		} finally {
			await closeSession(s);
		}
	}, SLOW);

	it("row 8: CLAUDE_PROJECT_DIR names the repo when the server's cwd is outside one", async () => {
		const dir = repo("baba-mcp-root-");
		const outside = scratch("baba-mcp-outside-");
		const s = await openSession({
			cwd: outside,
			env: { ...daemonEnv({ reply: [ONE_RESULT_LINE] }), CLAUDE_PROJECT_DIR: dir },
		});
		try {
			const res = await s.client.callTool({
				name: "search",
				arguments: { query: "hello world" },
			});
			expect(res.isError).toBeFalsy();
			expect((res.content as { text: string }[])[0].text).toBe(`${ONE_RESULT_TEXT}\n`);
			expect(existsSync(join(dir, ".baba", "daemon.sock"))).toBe(true);
			expect(existsSync(join(outside, ".baba"))).toBe(false);
		} finally {
			await closeSession(s);
		}
	}, SLOW);

	it("row 9: the server imports the client by name and touches neither net nor the socket path", () => {
		const src = readFileSync(SERVER, "utf8");
		expect(src).toMatch(
			/import\s*\{[^}]*\bsearch\b[^}]*\}\s*from\s*"\.\.\/src\/client\.ts"/,
		);
		expect(src).not.toMatch(/from\s*["'](node:)?net["']/);
		expect(src).not.toMatch(/daemon\.sock|["'`]\.baba/);
	});

	it("row 10: a second query in the same server emits no replayed startup lines", async () => {
		const dir = repo("baba-mcp-second-");
		const s = await openSession({
			cwd: dir,
			env: daemonEnv({
				lines: [[0, "baba: startup 1/2"]],
				bindMs: 800,
				reply: [ONE_RESULT_LINE],
			}),
		});
		try {
			const first: Progress[] = [];
			await s.client.callTool(
				{ name: "search", arguments: { query: "one" } },
				undefined,
				{ onprogress: (p) => first.push(p) },
			);
			expect(first.map((p) => p.message)).toEqual(["baba: startup 1/2"]);

			const second: Progress[] = [];
			const res = await s.client.callTool(
				{ name: "search", arguments: { query: "two" } },
				undefined,
				{ onprogress: (p) => second.push(p) },
			);
			expect(res.isError).toBeFalsy();
			expect(second).toEqual([]);
		} finally {
			await closeSession(s);
		}
	}, SLOW);

	it("row 11: an empty CLAUDE_PROJECT_DIR falls through to the server's cwd", async () => {
		const outside = scratch("baba-mcp-empty-out-");
		const s = await openSession({
			cwd: outside,
			env: { ...daemonEnv({ reply: [ONE_RESULT_LINE] }), CLAUDE_PROJECT_DIR: "" },
		});
		try {
			// The cwd is outside a repo: the error names it, so the empty value was not used as the root.
			const res = await s.client.callTool({
				name: "search",
				arguments: { query: "q" },
			});
			expect(res.isError).toBe(true);
			expect((res.content as { text: string }[])[0].text).toContain(
				`${realpathSync(outside)} is not inside a git repository`,
			);
		} finally {
			await closeSession(s);
		}

		const dir = repo("baba-mcp-empty-in-");
		const s2 = await openSession({
			cwd: dir,
			env: { ...daemonEnv({ reply: [ONE_RESULT_LINE] }), CLAUDE_PROJECT_DIR: "" },
		});
		try {
			const res = await s2.client.callTool({
				name: "search",
				arguments: { query: "hello world" },
			});
			expect(res.isError).toBeFalsy();
			expect(existsSync(join(dir, ".baba", "daemon.sock"))).toBe(true);
		} finally {
			await closeSession(s2);
		}
	}, SLOW);

	it("row 12: CLAUDE_PROJECT_DIR set to a linked worktree resolves to the main checkout", async () => {
		const main = repo("baba-mcp-wt-main-");
		const wt = join(scratch("baba-mcp-wt-holder-"), "wt");
		git(main, "worktree", "add", "-q", wt, "-b", "wt");
		// A mutated server could spawn in the worktree; stop that daemon too.
		repos.push(wt);
		const outside = scratch("baba-mcp-wt-out-");
		const s = await openSession({
			cwd: outside,
			env: { ...daemonEnv({ reply: [ONE_RESULT_LINE] }), CLAUDE_PROJECT_DIR: wt },
		});
		try {
			const res = await s.client.callTool({
				name: "search",
				arguments: { query: "hello world" },
			});
			expect(res.isError).toBeFalsy();
			expect(existsSync(join(main, ".baba", "daemon.sock"))).toBe(true);
			expect(existsSync(join(wt, ".baba"))).toBe(false);
		} finally {
			await closeSession(s);
		}
	}, SLOW);

	it("row 13: CLAUDE_PROJECT_DIR outside any repo is isError, not a fallback to the cwd", async () => {
		const cwdRepo = repo("baba-mcp-fb-cwd-");
		const nonRepo = scratch("baba-mcp-fb-env-");
		const s = await openSession({
			cwd: cwdRepo,
			env: { ...daemonEnv({ reply: [ONE_RESULT_LINE] }), CLAUDE_PROJECT_DIR: nonRepo },
		});
		try {
			const res = await s.client.callTool({
				name: "search",
				arguments: { query: "q" },
			});
			expect(res.isError).toBe(true);
			expect((res.content as { text: string }[])[0].text).toContain(
				// The env value is the root as given, not a realpath.
				`${nonRepo} is not inside a git repository`,
			);
			expect(existsSync(join(cwdRepo, ".baba"))).toBe(false);
		} finally {
			await closeSession(s);
		}
	}, SLOW);
});
