# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "playwright==1.59.0",
# ]
# ///
"""
Log in to a site by hand in the cluster's own Camoufox, shown to you over VNC,
then upload the captured Playwright storageState to the gateway.

    pnpm signin <ebay|reddit> [--signup]

The sign-in tab opens in the same browser process that later replays the
session, so build, fonts, TLS fingerprint and exit IP all match. A Linux
identity cannot be rendered on a Mac host (Camoufox only registers its bundled
fonts on Linux), which is why this no longer launches a local browser.

Uses kubectl for the port-forwards and a one-time x11vnc server bound to the
pod's localhost, then opens macOS Screen Sharing. Needs STEALTH_BROWSER_URL and
STEALTH_BROWSER_TOKEN in the environment. The state is uploaded straight from
memory and never written to disk.
"""

import base64
import contextlib
import json
import os
import secrets
import socket
import subprocess  # nosec B404
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterator

NAMESPACE = "stealth-browser"
POD = "deploy/camoufox"
USAGE = "usage: pnpm signin <ebay|reddit> [--signup]  (--signup is ebay only)"
ENV_HELP = "set STEALTH_BROWSER_URL and STEALTH_BROWSER_TOKEN in the environment"
SIGN_IN_URLS = {
    "ebay": "https://signin.ebay.com/",
    "reddit": "https://www.reddit.com/login/",
}
EBAY_SIGNUP_URL = "https://signup.ebay.com/pa/crte"
REDDIT_SESSION_MISSING = (
    "reddit_session cookie missing — finish logging in, then press Enter again"
)
PORT_WAIT_SECONDS = 15


def parse_args(argv: list[str]) -> tuple[str, bool]:
    args = [a for a in argv if a != "--signup"]
    signup = len(args) != len(argv)
    if len(args) != 1 or args[0] not in SIGN_IN_URLS or (signup and args[0] != "ebay"):
        raise SystemExit(USAGE)
    return args[0], signup


def load_env() -> tuple[str, str]:
    url = os.environ.get("STEALTH_BROWSER_URL")
    token = os.environ.get("STEALTH_BROWSER_TOKEN")
    if not url or not token:
        raise SystemExit(ENV_HELP)
    return url.rstrip("/"), token


def missing_cookie_error(profile: str, state: dict) -> str | None:
    if profile == "reddit" and not any(
        c["name"] == "reddit_session" for c in state["cookies"]
    ):
        return REDDIT_SESSION_MISSING
    return None


def upload_state(base_url: str, token: str, profile: str, state: dict) -> int:
    """PUT the storageState to the gateway and return the HTTP status."""
    request = urllib.request.Request(
        f"{base_url}/profiles/{profile}/state",
        data=json.dumps(state).encode(),
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # nosec B310
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def kubectl(*args: str) -> str:
    result = subprocess.run(  # nosec B603 B607
        ["kubectl", "-n", NAMESPACE, *args], check=True, capture_output=True, text=True
    )
    return result.stdout


def free_port() -> int:
    """A local port nothing listens on (fixed ports collide, e.g. Pieces on 39300)."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@contextlib.contextmanager
def running(*cmd: str) -> Iterator[subprocess.Popen]:
    proc = subprocess.Popen(  # nosec B603
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True
    )
    try:
        yield proc
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def wait_for_port(port: int, proc: subprocess.Popen) -> None:
    deadline = time.monotonic() + PORT_WAIT_SECONDS
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise SystemExit(
                f"kubectl port-forward exited: {proc.stderr.read().strip()}"
            )
        with (
            contextlib.suppress(OSError),
            socket.create_connection(("127.0.0.1", port), 1),
        ):
            return
        time.sleep(0.2)
    raise SystemExit(
        f"port-forward to localhost:{port} not ready after {PORT_WAIT_SECONDS}s"
    )


def stop_vnc() -> None:
    subprocess.run(  # nosec B603 B607
        ["kubectl", "-n", NAMESPACE, "exec", POD, "--", "pkill", "-x", "x11vnc"],
        capture_output=True,
        check=False,  # pkill exits 1 when nothing was running
    )


def pod_display() -> str:
    """The Xvfb display launch_server.py started (the pod runs exactly one)."""
    sockets = kubectl("exec", POD, "--", "ls", "/tmp/.X11-unix").split()
    if len(sockets) != 1:
        raise SystemExit(f"expected one X display in the pod, found {sockets}")
    return ":" + sockets[0].removeprefix("X")


def connect(playwright, ws_url: str, ws_path: str):
    try:
        return playwright.firefox.connect(ws_url, timeout=30_000)
    except Exception as error:  # noqa: BLE001 - re-raised with the secret path redacted
        raise SystemExit(str(error).replace(ws_path, "<WS_PATH>")) from None


def main() -> None:
    from playwright.sync_api import sync_playwright

    profile, signup = parse_args(sys.argv[1:])
    base_url, token = load_env()
    start_url = EBAY_SIGNUP_URL if signup else SIGN_IN_URLS[profile]

    ws_path = base64.b64decode(
        kubectl(
            "get", "secret", "stealth-browser-secrets", "-o", "jsonpath={.data.wsPath}"
        )
    ).decode()
    display = pod_display()
    # VNC passwords are capped at 8 characters.
    password = secrets.token_urlsafe(8)[:8]
    ws_port, vnc_port = free_port(), free_port()

    stop_vnc()  # a previous run that died before its cleanup
    try:
        with (
            running(
                "kubectl",
                "-n",
                NAMESPACE,
                "exec",
                POD,
                "--",
                "x11vnc",
                "-display",
                display,
                "-localhost",
                "-rfbport",
                "5900",
                "-passwd",
                password,
                "-forever",
                "-shared",
                "-quiet",
            ),
            running(
                "kubectl",
                "-n",
                NAMESPACE,
                "port-forward",
                POD,
                f"{ws_port}:3000",
                f"{vnc_port}:5900",
            ) as forward,
        ):
            wait_for_port(ws_port, forward)
            with sync_playwright() as playwright:
                browser = connect(
                    playwright, f"ws://127.0.0.1:{ws_port}/{ws_path}", ws_path
                )
                context = browser.new_context()
                try:
                    context.new_page().goto(start_url)
                    subprocess.run(  # nosec B603 B607
                        ["open", f"vnc://:{password}@127.0.0.1:{vnc_port}"], check=True
                    )
                    print(f"Screen Sharing is opening (password if asked: {password}).")
                    while True:
                        input(f"Log in to {profile} there, then press Enter here... ")
                        state = context.storage_state()
                        error = missing_cookie_error(profile, state)
                        if error:
                            print(error)
                            continue
                        status = upload_state(base_url, token, profile, state)
                        if status == 204:
                            print(
                                f"uploaded {profile} session ({len(state['cookies'])} cookies)"
                            )
                            return
                        raise SystemExit(f"upload failed: HTTP {status}")
                finally:
                    context.close()
                    browser.close()
    finally:
        stop_vnc()


if __name__ == "__main__":
    main()
