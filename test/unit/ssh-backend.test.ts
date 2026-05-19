/**
 * SshBackend tests inject an explicit `sshCommand` pointing at a Bash shim
 * inside a tmpdir, instead of trying to shadow `ssh` via PATH manipulation.
 * Bun.spawn does NOT honor runtime `process.env.PATH` mutations for its
 * argv[0] lookup, so the absolute-path-injection approach is the
 * portable test strategy.
 *
 * The shim dispatches scripted behaviors per test by inspecting the last
 * argument (the command `cat /path`) and a fixture-file mapping it reads
 * from `$PI_ACP_SSH_TEST_FIXTURES` at runtime.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SshBackend } from "@pi-acp/resources/sources/ssh";

let shimDir: string;
let shimPath: string;
let fixturesDir: string;

const FIXTURES_ENV = "PI_ACP_SSH_TEST_FIXTURES";

beforeAll(() => {
	shimDir = mkdtempSync(join(tmpdir(), "pi-acp-ssh-shim-"));
	fixturesDir = mkdtempSync(join(tmpdir(), "pi-acp-ssh-fixtures-"));

	// Fake ssh shim.
	// Reads scripted behaviour from $PI_ACP_SSH_TEST_FIXTURES/<host>/<path>
	// where <path> is the cat target rewritten as <path>.txt for success or
	// <path>.fail-<code> to force a non-zero exit, or <path>.sleep-<ms> to
	// force a delay before responding.
	const shim = `#!/usr/bin/env bash
# Skip "-o BatchMode=yes -o ConnectTimeout=N target -- cat /path"
# argv layout: [-o BatchMode=yes] [-o ConnectTimeout=N] target -- cat /path
set -u
host="$1" # iterated below
target=""
cmd_path=""
seen_double_dash=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; shift;;
    --) seen_double_dash=1; shift;;
    *)
      if [ -z "$target" ] && [ "$seen_double_dash" -eq 0 ]; then
        target="$1"
      elif [ "$seen_double_dash" -eq 1 ] && [ "$1" = "cat" ]; then
        shift
        cmd_path="$1"
      fi
      shift;;
  esac
done

# Extract host (after optional user@)
case "$target" in
  *@*) host="\${target#*@}";;
  *)   host="$target";;
esac

fixture_root="\${PI_ACP_SSH_TEST_FIXTURES:?missing}"
key="\${fixture_root}/\${host}\${cmd_path}"

if [ -f "\${key}.fail" ]; then
  code=$(cat "\${key}.fail")
  echo "fake ssh: simulated failure" >&2
  exit "$code"
fi
if [ -f "\${key}.sleep" ]; then
  # exec replaces bash with sleep in the same PID so SIGKILL from the
  # parent's timeout reaches the actual sleep (otherwise sleep would be
  # reparented and keep the pipe open past the timeout).
  exec sleep "$(cat "\${key}.sleep")"
fi
if [ -f "\${key}.ok" ]; then
  cat "\${key}.ok"
  exit 0
fi
echo "fake ssh: missing fixture for $host:$cmd_path" >&2
exit 2
`;
	shimPath = join(shimDir, "ssh");
	writeFileSync(shimPath, shim);
	chmodSync(shimPath, 0o755);

	process.env[FIXTURES_ENV] = fixturesDir;
});

afterAll(() => {
	delete process.env[FIXTURES_ENV];
	rmSync(shimDir, { recursive: true, force: true });
	rmSync(fixturesDir, { recursive: true, force: true });
});

function fixture(
	host: string,
	path: string,
	suffix: "ok" | "fail" | "sleep",
	payload: string,
): void {
	const dir = join(fixturesDir, host, ...path.split("/").slice(0, -1));
	mkdirSync(dir, { recursive: true });
	const filename = path.split("/").pop() ?? "";
	writeFileSync(join(fixturesDir, host, `${path}.${suffix}`.replace(/^\//, "")), payload);
	// silence unused variable warning
	void filename;
}

describe("SshBackend.reload + getAgentsFiles", () => {
	test("returns empty list when no agentsFiles declared", async () => {
		const backend = new SshBackend({
			id: "test",
			host: "fixture-host-empty",
			sshCommand: shimPath,
		});
		await backend.reload();
		expect(backend.getAgentsFiles()).toEqual([]);
		expect(backend.getSkills().diagnostics).toEqual([]);
	});

	test("cats each declared agentsFile and qualifies path with ssh:// scheme", async () => {
		const host = "fixture-host-1";
		fixture(host, "/home/v/AGENTS.md", "ok", "Hello from remote");
		fixture(host, "/home/v/SECURITY.md", "ok", "shh");
		const backend = new SshBackend({
			id: "remote",
			host,
			user: "v",
			paths: { agentsFiles: ["/home/v/AGENTS.md", "/home/v/SECURITY.md"] },
			sshCommand: shimPath,
		});
		await backend.reload();
		const files = backend.getAgentsFiles();
		expect(files).toHaveLength(2);
		expect(files[0]?.path).toBe(`ssh://v@${host}/home/v/AGENTS.md`);
		expect(files[0]?.content).toBe("Hello from remote");
		expect(files[1]?.path).toBe(`ssh://v@${host}/home/v/SECURITY.md`);
		expect(backend.getSkills().diagnostics).toEqual([]);
	});

	test("surfaces non-zero exit as a warning diagnostic without throwing", async () => {
		const host = "fixture-host-fail";
		fixture(host, "/etc/missing", "fail", "1");
		fixture(host, "/etc/exists", "ok", "present");
		const backend = new SshBackend({
			id: "mixed",
			host,
			paths: { agentsFiles: ["/etc/missing", "/etc/exists"] },
			sshCommand: shimPath,
		});
		await backend.reload();
		const files = backend.getAgentsFiles();
		expect(files).toHaveLength(1);
		expect(files[0]?.path).toBe(`ssh://${host}/etc/exists`);
		const diagnostics = backend.getSkills().diagnostics;
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(
			diagnostics.some(
				(d) => d.message.includes("/etc/missing") && d.message.includes("ssh exited"),
			),
		).toBe(true);
	});

	test("emits unsupported-kind diagnostics when paths.skills / .prompts / .extensions are declared", async () => {
		const backend = new SshBackend({
			id: "decl",
			host: "fixture-host-unsupported",
			paths: { skills: "/remote/skills", prompts: "/remote/prompts", extensions: "/remote/exts" },
			sshCommand: shimPath,
		});
		await backend.reload();
		const messages = backend
			.getSkills()
			.diagnostics.map((d) => d.message)
			.join("\n");
		expect(messages).toContain("skills discovery over SSH not yet implemented");
		expect(messages).toContain("prompts discovery over SSH not yet implemented");
		expect(messages).toContain("extensions discovery over SSH not yet implemented");
		expect(backend.getSkills().skills).toEqual([]);
		expect(backend.getPrompts().prompts).toEqual([]);
	});

	test("aborts a slow operation at the configured timeout", async () => {
		const host = "fixture-host-slow";
		fixture(host, "/slow/file", "sleep", "2");
		const backend = new SshBackend({
			id: "slow",
			host,
			paths: { agentsFiles: ["/slow/file"] },
			timeoutMs: 300,
			sshCommand: shimPath,
		});
		const start = Date.now();
		await backend.reload();
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(1_500);
		expect(backend.getAgentsFiles()).toEqual([]);
		const diagnostics = backend.getSkills().diagnostics;
		expect(diagnostics.some((d) => d.message.includes("/slow/file"))).toBe(true);
	});

	test("getSystemPrompt / getAppendSystemPrompt return empty defaults", () => {
		const backend = new SshBackend({ id: "x", host: "h", sshCommand: shimPath });
		expect(backend.getSystemPrompt()).toBeUndefined();
		expect(backend.getAppendSystemPrompt()).toEqual([]);
	});
});
