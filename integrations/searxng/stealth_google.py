"""Google web search through the stealth-browser gateway.

Google's desktop results need JavaScript, so this engine asks the gateway
(`POST /content`, Camoufox plus CAPTCHA solver) for the rendered page and parses
that. Result links on the rendered page are encrypted `/goto?url=` redirects.
Google answers each one with a 302 whose `Location` is the real URL, so the
engine reads that header (without following it) for every result.

Settings entry:

    - name: stealth google
      engine: stealth_google
      shortcut: gg
      timeout: 60

Environment: STEALTH_BROWSER_URL, STEALTH_BROWSER_TOKEN.
"""

import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode

from lxml import html
from lxml.etree import ParserError
from searx import network as searx_network
from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults

_log = logging.getLogger("searx.engines.stealth_google")

about = {
    "website": "https://www.google.com",
    "wikidata_id": "Q9366",
    "use_official_api": False,
    "require_api_key": False,
    "results": "HTML",
}

categories = ["general", "web"]
paging = False
timeout = 60.0

RENDER_WAIT_MS = 2000
RESOLVE_TIMEOUT_S = 5.0
RESOLVE_WORKERS = 8
GOOGLE = "https://www.google.com"
RESULT_ANCHOR = "//a[starts-with(@href, '/goto')][.//h3]"
INTERSTITIAL = "if you are not redirected"
REDIRECT_STATUSES = (301, 302, 303, 307, 308)
MAX_SNIPPET_ANCESTORS = 5


def request(query, params):
    lang = params.get("searxng_locale", "en").split("-")[0]
    search = urlencode({"q": query, "hl": "en" if lang == "all" else lang, "num": 10})
    params["url"] = f"{_env('STEALTH_BROWSER_URL')}/content"
    params["method"] = "POST"
    params["headers"]["Authorization"] = f"Bearer {_env('STEALTH_BROWSER_TOKEN')}"
    params["json"] = {
        "url": f"{GOOGLE}/search?{search}",
        "waitForTimeout": RENDER_WAIT_MS,
    }


def _env(name):
    value = os.environ.get(name)
    if not value:
        raise SearxEngineAPIException(f"stealth google engine requires {name}")
    return value


def response(resp):
    if not resp.text.strip():
        raise SearxEngineAPIException("gateway returned an empty body")
    try:
        doc = html.fromstring(resp.text)
    except ParserError as exc:
        raise SearxEngineAPIException("gateway returned an unparseable body") from exc
    anchors = doc.xpath(RESULT_ANCHOR)
    if not anchors and INTERSTITIAL in resp.text:
        raise SearxEngineAPIException("google returned its redirect interstitial instead of results")
    if not anchors:
        title = doc.findtext(".//title") or ""
        _log.warning("no results parsed (title=%r, body length=%d)", title, len(resp.text))
        return EngineResults()

    with ThreadPoolExecutor(max_workers=RESOLVE_WORKERS) as pool:
        urls = list(pool.map(_resolve, [a.get("href") for a in anchors]))
    if anchors and not any(urls):
        raise SearxEngineAPIException("google result redirects could not be resolved")

    res = EngineResults()
    seen = set()
    for anchor, url in zip(anchors, urls):
        if url is None or url in seen:
            continue
        seen.add(url)
        title = _text(anchor.xpath(".//h3")[0])
        res.add(res.types.MainResult(url=url, title=title, content=_snippet(anchor, title)))
    return res


def _resolve(goto_path):
    try:
        resp = searx_network.get(
            f"{GOOGLE}{goto_path}", allow_redirects=False, timeout=RESOLVE_TIMEOUT_S
        )
    except Exception:
        _log.warning("goto redirect request failed", exc_info=True)
        return None
    if resp.status_code not in REDIRECT_STATUSES:
        _log.warning("goto redirect answered %s, expected a redirect", resp.status_code)
        return None
    return resp.headers.get("location")


def _text(node):
    return re.sub(r"\s+", " ", " ".join(node.itertext())).strip()


def _snippet(anchor, title):
    """Text of the outermost ancestor (up to a few levels) holding only this result."""
    node = anchor
    for _ in range(MAX_SNIPPET_ANCESTORS):
        parent = node.getparent()
        if parent is None or len(parent.xpath(f".{RESULT_ANCHOR}")) != 1:
            break
        node = parent
    noise = [title, *(_text(cite) for cite in node.xpath(".//cite"))]
    site_label = _strip(_text(anchor), noise)
    return _strip(_text(node), [*noise, site_label])


def _strip(text, fragments):
    for fragment in filter(None, fragments):
        text = text.replace(fragment, " ")
    return re.sub(r"\s+", " ", text).strip()
