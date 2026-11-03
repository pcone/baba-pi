/** Temp git repos for the rows that need a checkout. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

export function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, {
		cwd,
		env: GIT_ENV,
		stdio: ["ignore", "ignore", "ignore"],
		timeout: 30_000,
	});
}

/** A temp git repo, with nothing else in it. */
export function tempRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	git(repo, "init", "-q");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-q", "-m", "init");
	return repo;
}
