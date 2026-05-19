#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""ssh-cat — read a remote file via system `ssh` with a hard wall-clock timeout.

Used by `src/resources/sources/ssh.ts` (PRD-002 §FR-2, Phase 6) so the timeout
lives at the shell layer (subprocess.run timeout=) instead of being wired
into Bun.spawn's killSignal machinery. Bun Shell `$` has no .timeout()
primitive (verified against bun 1.3.14 ShellPromise at runtime) and macOS
does not ship coreutils' `timeout(1)` by default, so a uv-shebanged Python
helper is the cross-platform shell-level path. PEP 723 inline metadata; no
external Python deps.

Exit codes mirror ssh:
  - 0          → success, file written to stdout
  - 1..254     → ssh's own non-zero exit (captured stderr forwarded)
  - 124        → wall-clock timeout (matches coreutils `timeout` convention)
  - 255        → invocation error (bad args, ssh binary not found, etc.)

Usage:
    ssh-cat.py --target user@host --path /etc/foo --timeout-sec 5 [--ssh ssh]

Tested by `test/unit/ssh-backend.test.ts` via the SshBackend `sshCommand`
override (which threads through this script's `--ssh` arg).
"""

from __future__ import annotations

import argparse
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(prog="ssh-cat")
    parser.add_argument("--target", required=True, help="user@host or host")
    parser.add_argument("--path", required=True, help="remote file path")
    parser.add_argument(
        "--timeout-sec", type=int, required=True, help="wall-clock timeout in seconds"
    )
    parser.add_argument(
        "--ssh", default="ssh", help="ssh binary path (override for tests)"
    )
    args = parser.parse_args()

    if args.timeout_sec < 1:
        sys.stderr.write("--timeout-sec must be >= 1\n")
        return 255

    alive_count = max(1, args.timeout_sec // 2)
    cmd = [
        args.ssh,
        "-o",
        "BatchMode=yes",
        "-o",
        f"ConnectTimeout={args.timeout_sec}",
        "-o",
        "ServerAliveInterval=2",
        "-o",
        f"ServerAliveCountMax={alive_count}",
        args.target,
        "--",
        "cat",
        args.path,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=args.timeout_sec,
            check=False,
        )
    except subprocess.TimeoutExpired:
        sys.stderr.write(f"ssh-cat: timeout after {args.timeout_sec}s\n")
        return 124
    except FileNotFoundError as e:
        sys.stderr.write(f"ssh-cat: {e}\n")
        return 255

    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
