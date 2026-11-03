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

import { DEFAULT_TOP_K, search, validTopK } from "../src/client.ts";

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
			if (!validTopK(n)) {
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

	// Status lines are progress, not results: stderr keeps stdout pipeable.
	// Writes chain so `process.exit` below cannot truncate one still pending.
	let pending = Promise.resolve();
	const onStatus = (msg: string) => {
		pending = pending.then(() => write(process.stderr, `[baba] ${msg}\n`));
	};

	try {
		const text = await search(process.cwd(), trimmed, topK, onStatus);
		await pending;
		await write(process.stdout, text);
		return 0;
	} catch (err) {
		await pending;
		return fail(err instanceof Error ? err.message : String(err));
	}
}

process.exit(await main(process.argv.slice(2)));
