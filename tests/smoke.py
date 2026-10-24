"""Isolated packaged-plugin checks against local Anthropic SSE; no real provider calls."""

import argparse
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import tarfile
import tempfile
import termios
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("--v1", required=True)
parser.add_argument("--v2", default="opencode")
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
root = Path(tempfile.mkdtemp(prefix="ember-dual-smoke-"))
print(f"Artifacts: {root}", flush=True)
pack = json.loads(
    subprocess.check_output(
        ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", str(root)],
        cwd=repo,
        text=True,
    )
)[0]
with tarfile.open(root / pack["filename"]) as archive:
    archive.extractall(root, filter="data")
calls = []


class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        calls.append(self.path)
        events = [
            (
                "message_start",
                {
                    "message": {
                        "id": "msg_local",
                        "type": "message",
                        "role": "assistant",
                        "model": body.get("model"),
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {
                            "input_tokens": 10,
                            "cache_creation_input_tokens": 60000,
                            "cache_read_input_tokens": 0,
                            "output_tokens": 1,
                        },
                    }
                },
            ),
            (
                "content_block_start",
                {"index": 0, "content_block": {"type": "text", "text": ""}},
            ),
            (
                "content_block_delta",
                {"index": 0, "delta": {"type": "text_delta", "text": "pong"}},
            ),
            ("content_block_stop", {"index": 0}),
            (
                "message_delta",
                {
                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": 5},
                },
            ),
            ("message_stop", {}),
        ]
        data = "".join(
            f"event: {kind}\ndata: " + json.dumps({"type": kind, **value}) + "\n\n"
            for kind, value in events
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    for major, binary in [(1, args.v1), (2, args.v2)]:
        directory = root / f"v{major}"
        directory.mkdir()
        (directory / "cfg").mkdir()
        (directory / "work").mkdir()
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("OPENCODE")
        }
        for key in ["DATA", "CONFIG", "STATE", "CACHE"]:
            env[f"XDG_{key}_HOME"] = str(directory / key.lower())
        env.update(
            OPENCODE_CONFIG_DIR=str(directory / "cfg"),
            EMBER_STATE_FILE=str(directory / "ember.json"),
            EMBER_TTL_SECONDS="0.01",
            EMBER_MIN_CONTEXT="1",
            OPENCODE_DISABLE_AUTOUPDATE="1",
            PWD=str(directory / "work"),
            TERM="xterm-256color",
        )
        config = {
            "model": "mock/claude-haiku-4.5",
            "autoupdate": False,
            "share": "disabled",
            "enabled_providers": ["mock"],
            "plugin" if major == 1 else "plugins": [
                f"opencode-ember@file:{root / pack['filename']}"
            ],
            "provider": {
                "mock": {
                    "npm": "@ai-sdk/anthropic",
                    "name": "mock",
                    "options": {
                        "baseURL": f"http://127.0.0.1:{server.server_port}/v1",
                        "apiKey": "fake-local-only",
                    },
                    "models": {
                        "claude-haiku-4.5": {
                            "name": "local mock",
                            "limit": {"context": 200000, "output": 8000},
                        }
                    },
                }
            },
        }
        (directory / "cfg" / "opencode.json").write_text(json.dumps(config))
        today = time.strftime("%Y-%m-%d", time.gmtime())
        state = directory / "ember.json"
        state.write_text(
            json.dumps(
                {
                    "version": 2,
                    "guard": "warn",
                    "always": True,
                    "sessions": {"legacy": {"kept": True}},
                    "future": {"keep": 1},
                    "days": {today: {"colds": 0, "coldUsd": 0, "pings": 7}},
                }
            )
        )

        def run(label, arguments):
            command = (
                [binary, "run"]
                + (["--standalone"] if major == 2 else [])
                + ["--format", "json"]
                + arguments
            )
            result = subprocess.run(
                command,
                env=env,
                cwd=directory / "work",
                capture_output=True,
                text=True,
                timeout=100,
            )
            (directory / f"{label}.out").write_text(
                result.stdout + "\n" + result.stderr
            )
            return result.stdout + result.stderr

        print(
            subprocess.check_output([binary, "--version"], text=True).strip(),
            flush=True,
        )
        output = run("seed", ["ping"])
        assert '"text":"pong"' in output, output
        session = next(
            json.loads(line)["sessionID"]
            for line in output.splitlines()
            if line.startswith("{") and "sessionID" in json.loads(line)
        )
        (directory / "sid").write_text(session)
        assert '"text":"pong"' in run("warn", ["-s", session, "ping again"])
        stored = json.loads(state.read_text())
        assert stored["days"][today]["colds"] == 1, stored
        assert (
            stored["version"] == 3
            and stored["always"]
            and stored["sessions"]["legacy"]["kept"]
        ), stored
        assert stored["future"]["keep"] == 1 and stored["days"][today]["pings"] == 7, (
            stored
        )
        stored["guard"] = "refuse"
        state.write_text(json.dumps(stored))
        count = len(calls)
        assert "Prompt blocked by ember guard refuse" in run(
            "refuse", ["-s", session, "blocked ping"]
        )
        assert len(calls) == count, calls
        if major == 1:
            assert '"type":"error"' in run(
                "card", ["-s", session, "--command", "ember"]
            )
            assert len(calls) == count, calls
        gain = subprocess.run(
            ["bun", str(root / "package" / "gain.ts"), "gain", "--json"],
            env=env,
            cwd=directory / "work",
            capture_output=True,
            text=True,
            timeout=20,
        )
        (directory / "gain.out").write_text(gain.stdout + gain.stderr)
        assert gain.returncode == 0 and '"colds": 1' in gain.stdout, gain.stdout
        if major == 2:
            (directory / "cfg" / "cli.json").write_text(
                json.dumps(
                    {"plugins": [f"opencode-ember@file:{root / pack['filename']}"]}
                )
            )
        if major in (1, 2):
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
            process = subprocess.Popen(
                [binary]
                + (["--standalone"] if major == 2 else [])
                + ["--session", session, str(directory / "work")],
                env=env,
                cwd=directory / "work",
                stdin=slave,
                stdout=slave,
                stderr=slave,
                start_new_session=True,
            )
            os.close(slave)
            capture = b""
            start = time.monotonic()
            stage = 0
            try:
                while time.monotonic() - start < 35:
                    if select.select([master], [], [], 0.2)[0]:
                        try:
                            capture += os.read(master, 65536)
                        except OSError:
                            break
                    elapsed = time.monotonic() - start
                    for target, data in [
                        (7, b"/ember"),
                        (9, b"\r"),
                        (11, b"\r"),
                        (16, b"/ember guard warn"),
                        (18, b"\r"),
                        (20, b"\r"),
                        (24, b"ping tui\r"),
                        (32, b"\x03\x03"),
                    ][stage : stage + 1]:
                        if elapsed > target:
                            os.write(master, data)
                            stage += 1
                    if process.poll() is not None:
                        break
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=10)
                os.close(master)
            (directory / "tui.capture").write_bytes(capture)
            text = re.sub(
                r"\x1b\[[0-?]*[ -/]*[@-~]", "", capture.decode(errors="replace")
            )
            assert "cold rewrite" in text, f"V{major} card toast missing"
            assert "Sending anyway" in text, f"V{major} warning toast missing"
            assert json.loads(state.read_text())["days"][today]["colds"] == 2
        print(
            f"PASS V{major}: packaged loader, warn, refuse (zero calls), card, cold write, gain, legacy fields",
            flush=True,
        )
finally:
    server.shutdown()
    (root / "calls.json").write_text(json.dumps(calls))
