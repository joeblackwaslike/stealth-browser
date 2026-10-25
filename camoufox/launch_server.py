"""
Launch Camoufox as a remote Playwright server with a stable endpoint and a
pinned fingerprint:

    ws://<host>:<PORT>/<WS_PATH>

The fingerprint at FINGERPRINT_PATH is a flat Camoufox config produced by
scripts/gen_fingerprint.py. launch_options() only fills keys missing from the
passed config, so every launch reuses the same UA, screen, fonts, WebGL and
noise seeds. Locale and timezone are pinned in the file; geoip=True fills the
WebRTC IP and coordinates from the exit IP at launch.

The browser draws on an Xvfb screen the size the fingerprint claims, so a
media query sees the same screen as window.screen, and `pnpm signin` can show
it over VNC.
"""

import base64
import json
import os
import subprocess  # nosec B404
import sys
from pathlib import Path

import orjson
from camoufox.server import LAUNCH_SCRIPT, get_nodejs, to_camel_case_dict
from camoufox.utils import launch_options
from camoufox.virtdisplay import VirtualDisplay

MIN_WS_PATH_LENGTH = 32


def sized_display(width: int, height: int) -> VirtualDisplay:
    """Camoufox's VirtualDisplay, with its 1x1 Xvfb screen resized."""
    screen = f"{width}x{height}x24"

    class SizedDisplay(VirtualDisplay):
        xvfb_args = tuple(screen if arg == "1x1x24" else arg for arg in VirtualDisplay.xvfb_args)

    if screen not in SizedDisplay.xvfb_args:
        sys.exit("VirtualDisplay no longer passes -screen 0 1x1x24; update sized_display()")
    return SizedDisplay()


def main() -> None:
    ws_path = os.environ.get("WS_PATH", "")
    if len(ws_path) < MIN_WS_PATH_LENGTH:
        sys.exit(f"WS_PATH must be set to at least {MIN_WS_PATH_LENGTH} characters")

    port = int(os.environ.get("PORT", "3000"))
    fingerprint_path = os.environ.get("FINGERPRINT_PATH", "/etc/camoufox/fingerprint.json")
    with open(fingerprint_path, encoding="utf-8") as f:
        fingerprint = json.load(f)

    # camoufox.server.launch_server() goes straight to launch_options(), which,
    # unlike Camoufox(), has no headless="virtual" handling: Playwright would
    # read the string as truthy and run real headless. Start Xvfb ourselves.
    display = sized_display(fingerprint["screen.width"], fingerprint["screen.height"]).get()

    options = launch_options(
        headless=False,
        virtual_display=display,
        geoip=True,
        os="linux",
        config=fingerprint,
        # The config deliberately sets navigator/screen/UA keys; this only
        # silences the LeakWarnings Camoufox prints for manual overrides.
        i_know_what_im_doing=True,
        host="0.0.0.0",  # nosec B104 - the container is meant to be reachable on the pod network
        port=port,
        ws_path=ws_path,
    )

    # Same as camoufox.server.launch_server(), except stdout is piped so the
    # "Websocket endpoint: ws://.../<WS_PATH>" line never reaches the logs.
    nodejs = get_nodejs()
    server = subprocess.Popen(  # nosec B603
        [nodejs, str(LAUNCH_SCRIPT)],
        cwd=Path(nodejs).parent / "package",
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    server.stdin.write(base64.b64encode(orjson.dumps(to_camel_case_dict(options))).decode())
    server.stdin.close()
    for line in server.stdout:
        print(line.replace(ws_path, "<WS_PATH>"), end="", flush=True)
    sys.exit(server.wait())


if __name__ == "__main__":
    main()
