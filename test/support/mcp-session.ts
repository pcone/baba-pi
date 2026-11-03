/**
 * Drives `bin/baba-mcp.ts` as a child process over stdio, with the SDK client.
 *
 * The transport records every stdout line verbatim, so a row can assert that
 * nothing but protocol frames reached stdout. The server runs with the
 * environment given here: CLAUDE_PROJECT_DIR is removed unless `env` sets it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export const SERVER = resolve(import.meta.dir, "..", "..", "bin", "baba-mcp.ts");

export class RecordingStdioTransport implements Transport {
	onclose?: () => void;
	onerror?: (err: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	/** Every stdout line, verbatim, in arrival order. */
	readonly rawLines: string[] = [];
	/** Parsed frames from stdout, in arrival order. */
	readonly messages: JSONRPCMessage[] = [];
	/** Everything the server wrote to stderr. */
	stderr = "";

	private child: ChildProcess | null = null;
	private partial = "";
	private readonly exited: Promise<void>;
	private resolveExited!: () => void;

	constructor(
		private readonly command: string,
		private readonly cwd: string,
		private readonly env: Record<string, string>,
	) {
		this.exited = new Promise<void>((res) => {
			this.resolveExited = res;
		});
	}

	async start(): Promise<void> {
		const child = spawn(this.command, [], {
			cwd: this.cwd,
			env: this.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
		child.on("error", (err) => this.onerror?.(err));
		child.on("close", () => {
			this.resolveExited();
			this.onclose?.();
		});
	}

	private onStdout(chunk: string): void {
		this.partial += chunk;
		let idx = this.partial.indexOf("\n");
		while (idx >= 0) {
			const line = this.partial.slice(0, idx);
			this.partial = this.partial.slice(idx + 1);
			this.rawLines.push(line);
			let frame: JSONRPCMessage;
			try {
				frame = JSON.parse(line) as JSONRPCMessage;
			} catch {
				// Not a frame: kept in rawLines, and frameProblems reports it.
				idx = this.partial.indexOf("\n");
				continue;
			}
			this.messages.push(frame);
			this.onmessage?.(frame);
			idx = this.partial.indexOf("\n");
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.stdin?.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
		await this.exited;
		clearTimeout(timer);
	}
}

export type McpSession = {
	client: Client;
	transport: RecordingStdioTransport;
	/** Stops the server and returns once it has exited. */
	close: () => Promise<void>;
};

/** Environment for the server: the caller's, with CLAUDE_PROJECT_DIR unset unless given. */
function serverEnv(overrides: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
	}
	return { ...env, ...overrides };
}

/** Start the server in `cwd` and complete the MCP handshake. */
export async function openSession(opts: {
	cwd: string;
	env?: Record<string, string>;
}): Promise<McpSession> {
	const transport = new RecordingStdioTransport(
		SERVER,
		opts.cwd,
		serverEnv(opts.env ?? {}),
	);
	const client = new Client({ name: "baba-test", version: "0.0.0" });
	await client.connect(transport);
	return {
		client,
		transport,
		close: async () => {
			await client.close();
		},
	};
}

/** Lines on stdout that are not JSON-RPC 2.0 frames. Empty when stdout is clean. */
export function frameProblems(transport: RecordingStdioTransport): string[] {
	const bad: string[] = [];
	for (const line of transport.rawLines) {
		try {
			const m = JSON.parse(line) as { jsonrpc?: unknown };
			if (m.jsonrpc !== "2.0") bad.push(line);
		} catch {
			bad.push(line);
		}
	}
	return bad;
}
