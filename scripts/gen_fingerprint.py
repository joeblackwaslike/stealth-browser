# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "cloverlabs-camoufox[geoip]==0.6.0",
#     "playwright==1.59.0",
# ]
# ///
"""
Generate the pinned Linux fingerprint once and write it to
profiles/fingerprint.json (or the path given as the first argument).

Needs a fetched Camoufox browser, because launch_options() reads the installed
Firefox version and properties.json.
"""

import json
import sys
from pathlib import Path

from camoufox.utils import launch_options

# geoip=True sets these from the exit IP at launch. addons holds local cache
# paths that launch_options() rewrites on every launch.
DROPPED_PREFIXES = ("timezone", "locale:", "geolocation:", "webrtc:", "addons")
# geoip only fills keys the config leaves unset, and it draws the locale at
# random from the region's languages (es-US, tl-US, ...) on every launch. Pin
# them so every launch presents the same language and timezone.
PINNED = {
    "locale:language": "en",
    "locale:region": "US",
    "locale:script": "Latn",
    "timezone": "America/New_York",
}
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "profiles" / "fingerprint.json"


def decode_config(env: dict) -> dict:
    """Reassemble the config launch_options() splits into CAMOU_CONFIG_1..N."""
    chunks = sorted(
        (int(key.removeprefix("CAMOU_CONFIG_")), value)
        for key, value in env.items()
        if key.startswith("CAMOU_CONFIG_")
    )
    if not chunks:
        raise SystemExit("launch_options() returned no CAMOU_CONFIG_* env vars")
    return json.loads("".join(value for _, value in chunks))


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    config = decode_config(launch_options(os="linux", headless=False)["env"])
    pinned = {k: v for k, v in config.items() if not k.startswith(DROPPED_PREFIXES)} | PINNED
    out.write_text(json.dumps(pinned, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {len(pinned)} keys to {out}: {pinned.get('navigator.userAgent')}")


if __name__ == "__main__":
    main()
