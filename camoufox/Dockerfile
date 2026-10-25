# Camoufox remote Playwright server.
#
# Camoufox is a patched Firefox (no Chromium) tuned to resist bot detection.
# We bake the patched Firefox into the image so the container is self-contained
# and does not pull hundreds of megabytes on every cold start.

# We install the cloverlabs-camoufox pip package, not the original camoufox
# one. The original has been frozen on PyPI at 0.4.11 (Jan 2025, Firefox 135)
# since the maintainer stepped back; cloverlabs-camoufox is the same wrapper
# published by the project's current active maintainer and is endorsed in the
# upstream README. It still downloads the official browser binaries from
# daijro/camoufox GitHub releases, so only the wrapper comes from the fork.
ARG CAMOUFOX_VERSION=0.6.0

# The browser build to fetch, pinned separately from the pip wrapper. Since
# 0.5.x the wrapper no longer hard-pins a browser; a bare `camoufox fetch`
# resolves "latest in channel" by the camoufox build label, and the ordering
# quirk (beta.24 sorts above alpha.26) makes it pick the old Firefox 135 build.
# Pinning an exact version sidesteps that and keeps the image reproducible.
#
# Upstream ships different build labels per architecture for the same Firefox
# version (the lin.x86_64 asset was rebuilt as alpha.26), hence two ARGs.
#
# Stay on a build whose TLS handshake matches current stock Firefox. eBay's edge
# 403s Camoufox 150 on the first request (its ClientHello still offers cipher
# 0xC00A and ffdhe groups that Firefox has since dropped); 156 matches Firefox
# 158 on JA3, JA4 and the HTTP2 fingerprint. Check tls.peet.ws on every bump.
ARG CAMOUFOX_BROWSER_VERSION=156.0.1
ARG CAMOUFOX_BUILD_AMD64=beta.36
ARG CAMOUFOX_BUILD_ARM64=beta.36

# Pin to bookworm on purpose: several runtime libraries below (notably
# libasound2) were renamed with a t64 suffix in Debian trixie, so a floating
# slim tag would break the apt install with no warning.
FROM python:3.14-slim-bookworm

ARG CAMOUFOX_VERSION
ARG CAMOUFOX_BROWSER_VERSION
ARG CAMOUFOX_BUILD_AMD64
ARG CAMOUFOX_BUILD_ARM64
ENV CAMOUFOX_VERSION=${CAMOUFOX_VERSION}

# Firefox runtime libraries. Camoufox ships a real Firefox binary, so it needs
# the same shared libraries a desktop Firefox would. x11vnc is only started by
# `pnpm signin`, which shows the Xvfb screen over a port-forward.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxtst6 \
        libnss3 \
        libnspr4 \
        libasound2 \
        libdbus-glib-1-2 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libpangocairo-1.0-0 \
        libgbm1 \
        fonts-liberation \
        ca-certificates \
        xvfb \
        x11vnc \
    && rm -rf /var/lib/apt/lists/*

# The geoip extra lets the browser line up its timezone, locale and
# geolocation with the exit IP, which matters for staying under the radar.
#
# cloverlabs-camoufox declares playwright unpinned, but launch_server() drives
# Playwright through an internal (driver/package/lib/browserServerImpl.js)
# that ships up to Playwright 1.59.0 and is gone from 1.60.0. Pin to the last
# version that has it. Revisit this pin whenever CAMOUFOX_VERSION is bumped.
ARG PLAYWRIGHT_VERSION=1.59.0
RUN pip install --no-cache-dir \
        "cloverlabs-camoufox[geoip]==${CAMOUFOX_VERSION}" \
        "playwright==${PLAYWRIGHT_VERSION}"

# Upstream bug workaround: `camoufox sync` dedupes release assets by build
# label alone (seen_builds in pkgman.py), and upstream reuses labels across
# Firefox versions. The FF152 prerelease (152.0.4-alpha.25) is listed before
# FF150 and claims the "alpha.25" label, so the arm64 FF150 build
# (150.0.2-alpha.25) never makes it into the sync cache and `fetch` cannot
# see it. Dedupe by the full version string instead. If a wrapper bump makes
# this sed a no-op, the fetch verification below still fails the build, so
# drift cannot slip through. Revisit whenever CAMOUFOX_VERSION is bumped.
RUN sed -i \
        -e 's/if version\.build in seen_builds:/if version.full_string in seen_builds:/' \
        -e 's/seen_builds\.add(version\.build)/seen_builds.add(version.full_string)/' \
        "$(python -c 'import camoufox, os; print(os.path.join(os.path.dirname(camoufox.__file__), "pkgman.py"))')"

# Run as an unprivileged user. `camoufox fetch` puts the browser, GeoIP
# database and addons under the calling user's cache dir (~/.cache/camoufox),
# so we switch users BEFORE fetching, otherwise the server (running as this
# user) would not find the browser at runtime.
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin camoufox
USER 1000
WORKDIR /home/camoufox

# Download the pinned patched Firefox, plus the GeoIP database and default
# addons. TARGETARCH is set by buildx (amd64/arm64) and picks the matching
# upstream build label.
#
# The trailing check is load-bearing: `camoufox fetch` prints errors like
# "Version not found in cache" but still exits 0, so without it a failed
# fetch would produce a browserless image that CI would happily publish.
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
        amd64) build="${CAMOUFOX_BUILD_AMD64}" ;; \
        arm64) build="${CAMOUFOX_BUILD_ARM64}" ;; \
        *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && python -m camoufox fetch "official/${CAMOUFOX_BROWSER_VERSION}-${build}" \
    && python -c "from camoufox.pkgman import installed_verstr; \
v = installed_verstr(); \
assert v == '${CAMOUFOX_BROWSER_VERSION}-${build}', f'expected ${CAMOUFOX_BROWSER_VERSION}-${build}, got {v}'; \
print('installed:', v)"

COPY --chown=camoufox:camoufox launch_server.py /home/camoufox/launch_server.py

# WS_PATH has no default on purpose: it is the only secret guarding the
# endpoint, so launch_server.py refuses to start without one (>= 32 chars).
# Mount the pinned fingerprint at FINGERPRINT_PATH.
ENV PORT=3000 \
    FINGERPRINT_PATH=/etc/camoufox/fingerprint.json
EXPOSE 3000

# NOTE: the bare `camoufox server` CLI takes NO flags. It calls launch_server()
# with no arguments (see upstream pythonlib/camoufox/__main__.py), which binds a
# RANDOM port and a RANDOM ws path, both only printed to stdout. That is useless
# behind a fixed Kubernetes Service. launch_server.py follows the same launch
# path but pins host, port, ws-path and the fingerprint, and keeps the ws-path
# out of the logs.
CMD ["python", "/home/camoufox/launch_server.py"]
