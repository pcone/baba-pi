/**
 * Helpers for rows that spawn a fake daemon through the real client.
 *
 * `fakeServeBin` is a BABA_BIN that runs `fake-serve.ts`; the behaviour comes
 * from `FAKE_*` env (see that file). `killSpawnedDaemon` stops the process the
 * client spawned, found through the repo's pid file.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FAKE_SERVE = resolve(import.meta.dir, "fake-serve.ts");

export const ONE_RESULT_LINE = JSON.stringify({
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
});
export const ONE_RESULT_TEXT = "1. [0.876] docs/a.md — Intro\n   hello world";


export type FakeDaemonOptions = {
	/** [atMs, line] pairs written to the daemon log. */
	lines?: [number, string][];
	/** When the socket binds, ms after start. */
	bindMs?: number;
	/** Lines sent back for each request. */
	reply?: string[];
	/** File each daemon start appends a line to. */
	mark?: string;
};

let compiled: string | null = null;

/**
 * A `BABA_BIN` for the fake daemon: `fake-serve.ts` compiled to an executable
 * named `baba`. The client's pid check matches the executable's name against
 * the binary's, so a shell wrapper (which execs bun) would not pass as baba.
 * Built once per test process.
 */
export function fakeServeBin(): string {
	if (compiled === null) {
		const dir = mkdtempSync(join(tmpdir(), "baba-fake-bin-"));
		const bin = join(dir, "baba");
		// Run in the scratch dir: the compiler leaves a temp file in its cwd.
		execFileSync(process.execPath, ["build", "--compile", FAKE_SERVE, "--outfile", bin], {
			cwd: dir,
			stdio: "ignore",
			timeout: 120_000,
		});
		process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
		compiled = bin;
	}
	return compiled;
}

/** Env for one fake daemon run. */
export function fakeEnv(opts: FakeDaemonOptions): Record<string, string> {
	const env: Record<string, string> = {
		FAKE_LINES: JSON.stringify(opts.lines ?? []),
		FAKE_BIND_MS: String(opts.bindMs ?? 0),
		FAKE_REPLY: JSON.stringify(opts.reply ?? []),
	};
	if (opts.mark !== undefined) env.FAKE_MARK = opts.mark;
	return env;
}

/** Stop the daemon a test spawned. No pid file means nothing was spawned. */
export function killSpawnedDaemon(repo: string): void {
	let pid: number;
	try {
		pid = Number(readFileSync(join(repo, ".baba", "daemon.pid"), "utf8").trim());
	} catch {
		return;
	}
	if (pid > 0 && pid !== process.pid) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already exited
		}
	}
}

/** Set process.env keys; the returned function restores them. */
export function setEnv(vars: Record<string, string>): () => void {
	const saved = new Map<string, string | undefined>();
	for (const [k, v] of Object.entries(vars)) {
		saved.set(k, process.env[k]);
		process.env[k] = v;
	}
	return () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
}
