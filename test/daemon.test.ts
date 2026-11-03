/**
 * Rows for `ensureDaemon`'s status callback and the daemon log.
 *
 * These call the real client in-process; the daemon it spawns is
 * `test/support/fake-serve.ts`, which writes its startup lines to the log
 * the client redirected its stderr to.
 *
 * Run: bun test test/daemon.test.ts
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemon } from "../src/client.ts";
import {
	fakeEnv,
	fakeServeBin,
	killSpawnedDaemon,
	setEnv,
} from "./support/fake-daemon.ts";

/** A bare temp dir standing in for a repo root; `ensureDaemon` needs no git. */
function tempRoot(prefix: string): { root: string; bin: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const bin = fakeServeBin(root);
	return {
		root,
		bin,
		cleanup: () => {
			killSpawnedDaemon(root);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("ensureDaemon status callback", () => {
	it("passes a spawned daemon's startup lines to the callback before it answers", async () => {
		const t = tempRoot("baba-daemon-status-");
		const restore = setEnv({
			BABA_BIN: t.bin,
			...fakeEnv({
				lines: [
					[0, "baba: startup 1/2"],
					[200, "baba: startup 2/2"],
				],
				bindMs: 600,
			}),
		});
		const got: string[] = [];
		try {
			const sock = await ensureDaemon(t.root, (m) => got.push(m));
			expect(sock).toBe(join(t.root, ".baba", "daemon.sock"));
			expect(got).toEqual(["baba: startup 1/2", "baba: startup 2/2"]);
			expect(readFileSync(join(t.root, ".baba", "daemon.log"), "utf8")).toBe(
				"baba: startup 1/2\nbaba: startup 2/2\n",
			);
		} finally {
			restore();
			t.cleanup();
		}
	});

	it("keeps waiting when the status callback throws", async () => {
		const t = tempRoot("baba-daemon-throw-");
		const restore = setEnv({
			BABA_BIN: t.bin,
			...fakeEnv({ lines: [[0, "baba: startup"]], bindMs: 400 }),
		});
		try {
			const sock = await ensureDaemon(t.root, () => {
				throw new Error("callback bug");
			});
			expect(sock).toBe(join(t.root, ".baba", "daemon.sock"));
		} finally {
			restore();
			t.cleanup();
		}
	}, 20_000);

	it("a caller that finds a starting daemon tails from the end of the log and spawns none", async () => {
		// A starts the daemon; B joins once A has seen L1. B must see L2 only,
		// and the fake's start mark must show one spawn.
		const t = tempRoot("baba-daemon-waiter-");
		const mark = join(t.root, "starts");
		const restore = setEnv({
			BABA_BIN: t.bin,
			...fakeEnv({
				lines: [
					[0, "L1"],
					[1000, "L2"],
				],
				bindMs: 1800,
				mark,
			}),
		});
		const a: string[] = [];
		const b: string[] = [];
		try {
			const spawner = ensureDaemon(t.root, (m) => a.push(m));
			while (!a.includes("L1")) await Bun.sleep(20);
			const waiter = ensureDaemon(t.root, (m) => b.push(m));
			await Promise.all([spawner, waiter]);
			expect(a).toEqual(["L1", "L2"]);
			expect(b).toEqual(["L2"]);
			expect(readFileSync(mark, "utf8").trim().split("\n")).toHaveLength(1);
		} finally {
			restore();
			t.cleanup();
		}
	}, 20_000);
});
