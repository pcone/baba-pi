#!/usr/bin/env bun
/**
 * Stand-in for `baba serve --repo R --socket S`, for the daemon-client rows.
 *
 * Behaviour comes from the environment, so one script serves every row:
 *   FAKE_LINES    JSON [[atMs, line], ...]: each line goes to stderr at atMs.
 *   FAKE_BIND_MS  when the socket binds (and the process starts answering).
 *   FAKE_REPLY    JSON array of lines sent back for each request line.
 *   FAKE_MARK     file to append one line to per start (spawn counting).
 *
 * Lines written to stderr are the daemon log, as in the real spawn.
 */
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";

const args = process.argv.slice(2);
const sock = args[args.indexOf("--socket") + 1];
const lines = JSON.parse(process.env.FAKE_LINES ?? "[]") as [number, string][];
const bindMs = Number(process.env.FAKE_BIND_MS ?? "0");
const replies = JSON.parse(process.env.FAKE_REPLY ?? "[]") as string[];

if (process.env.FAKE_MARK) {
	appendFileSync(process.env.FAKE_MARK, `${process.pid}\n`);
}

const start = Date.now();
for (const [at, line] of lines) {
	setTimeout(() => process.stderr.write(`${line}\n`), at);
}

setTimeout(() => {
	if (existsSync(sock)) unlinkSync(sock);
	const server = createServer((conn) => {
		conn.setEncoding("utf8");
		let buf = "";
		conn.on("data", (chunk: string) => {
			buf += chunk;
			let idx = buf.indexOf("\n");
			while (idx >= 0) {
				buf = buf.slice(idx + 1);
				conn.write(replies.map((r) => `${r}\n`).join(""));
				idx = buf.indexOf("\n");
			}
		});
	});
	server.listen(sock);
}, Math.max(0, bindMs - (Date.now() - start)));
