#!/usr/bin/env bun
/**
 * baba-search — one semantic query against this repository's baba daemon.
 *
 * usage: baba-search "<query>" [-k N]
 *
 * Resolves the main repo root from the cwd, so any worktree or subdirectory
 * of the repo works, starts the daemon through the shared client if it is not
 * already running, sends one request and prints the ranked results. Results go
 * to stdout; diagnostics go to stderr, so stdout pipes cleanly.
 *
 * The embedder lives in the daemon — this script never loads it, and never
 * polls: `ensureDaemon` is the only thing that waits.
 *
 * Exit status: 0 results, 1 no repo or no daemon, 2 usage.
 */

import {
	daemonRequest,
	ensureDaemon,
	findMainRoot,
	formatResults,
	type ServeResponse,
} from "../src/client.ts";

const DEFAULT_TOP_K = 10;
const USAGE = 'usage: baba-search "<query>" [-k N]';

/** Write, and wait for the flush: `process.exit` truncates a pending pipe write. */
function write(
	stream: { write(text: string, cb: () => void): unknown },
	text: string,
): Promise<void> {
	return new Promise((res) => stream.write(text, () => res()));
}

async function usageError(message: string): Promise<number> {
	await write(process.stderr, `baba-search: ${message}\n${USAGE}\n`);
	return 2;
}

async function fail(message: string): Promise<number> {
	await write(process.stderr, `baba-search: ${message}\n`);
	return 1;
}

async function main(argv: string[]): Promise<number> {
	let query: string | null = null;
	let topK = DEFAULT_TOP_K;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-k") {
			const raw = argv[++i];
			const n = raw === undefined ? Number.NaN : Number(raw);
			if (!Number.isInteger(n) || n < 1) {
				return usageError(
					`-k needs a positive integer, got ${raw === undefined ? "nothing" : `"${raw}"`}`,
				);
			}
			topK = n;
		} else if (arg.startsWith("-")) {
			return usageError(`unknown option "${arg}"`);
		} else if (query === null) {
			query = arg;
		} else {
			return usageError(
				`one query per call; got a second one ("${arg}")`,
			);
		}
	}

	if (query === null) {
		return usageError("no query");
	}
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		return usageError("empty query");
	}

	const cwd = process.cwd();
	const mainRoot = findMainRoot(cwd);
	if (mainRoot === null) {
		return fail(
			`${cwd} is not inside a git repository — baba indexes a repo's main checkout, so run this from one (or from a worktree of one)`,
		);
	}

	let response: ServeResponse;
	try {
		const sockPath = await ensureDaemon(mainRoot);
		response = await daemonRequest(
			{ type: "search", query: trimmed, top_k: topK },
			sockPath,
		);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}

	// Status lines are progress, not results: stderr keeps stdout pipeable.
	for (const status of (response as { statuses?: string[] }).statuses ?? []) {
		await write(process.stderr, `[baba] ${status}\n`);
	}

	switch (response.type) {
		case "results":
			await write(process.stdout, `${formatResults(response.results)}\n`);
			return 0;
		case "error":
			return fail(`baba error: ${response.msg}`);
		default:
			// The client's read loop returns only `results` or `error`.
			return fail(`unexpected response: ${JSON.stringify(response)}`);
	}
}

process.exit(await main(process.argv.slice(2)));
