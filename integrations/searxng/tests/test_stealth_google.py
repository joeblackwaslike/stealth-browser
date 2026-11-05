import logging
from types import SimpleNamespace

import pytest
from conftest import FIXTURES, SearxEngineAPIException

import stealth_google

def fake_response(text):
    return SimpleNamespace(text=text, status_code=200)


def fixture_page():
    return (FIXTURES / "google_results.html").read_text()


@pytest.fixture
def resolver(monkeypatch):
    calls = []

    def resolve(goto_path):
        calls.append(goto_path)
        return f"https://site-{len(calls)}.test/page"

    monkeypatch.setattr(stealth_google, "_resolve", resolve)
    return calls


def test_returns_every_organic_result_with_its_resolved_url(resolver):
    results = stealth_google.response(fake_response(fixture_page()))
    assert len(results) == 8
    assert len(resolver) == 8
    assert all(path.startswith("/goto?url=") for path in resolver)
    assert {r.url for r in results} == {f"https://site-{i}.test/page" for i in range(1, 9)}
    for r in results:
        assert "/goto" not in r.url
        assert r.title


def test_titles_come_from_the_result_headings(resolver):
    results = stealth_google.response(fake_response(fixture_page()))
    assert results[0].title == "asyncio — Asynchronous I/O"
    assert len({r.title for r in results}) == 8


def test_drops_a_result_whose_redirect_cannot_be_resolved(monkeypatch):
    answers = iter([None] + [f"https://site-{i}.test/" for i in range(7)])
    monkeypatch.setattr(stealth_google, "_resolve", lambda path: next(answers))
    results = stealth_google.response(fake_response(fixture_page()))
    assert len(results) == 7


def test_raises_when_no_redirect_resolves(monkeypatch):
    monkeypatch.setattr(stealth_google, "_resolve", lambda path: None)
    with pytest.raises(SearxEngineAPIException):
        stealth_google.response(fake_response(fixture_page()))


def test_redirect_interstitial_raises_instead_of_returning_empty():
    stub = (
        "<html><head><title>Google Search</title></head><body>"
        "Please click here if you are not redirected within a few seconds.</body></html>"
    )
    with pytest.raises(SearxEngineAPIException):
        stealth_google.response(fake_response(stub))


def test_resolve_reads_location_without_following_redirects(monkeypatch):
    seen = {}

    def fake_get(url, **kwargs):
        seen.update(url=url, **kwargs)
        return SimpleNamespace(status_code=302, headers={"location": "https://docs.python.org/3/"})

    monkeypatch.setattr(stealth_google.searx_network, "get", fake_get)
    assert stealth_google._resolve("/goto?url=abc") == "https://docs.python.org/3/"
    assert seen["url"] == "https://www.google.com/goto?url=abc"
    assert seen["allow_redirects"] is False


def test_resolve_returns_none_when_google_does_not_redirect(monkeypatch):
    monkeypatch.setattr(
        stealth_google.searx_network, "get", lambda url, **kw: SimpleNamespace(status_code=200, headers={})
    )
    assert stealth_google._resolve("/goto?url=abc") is None


def test_request_posts_search_url_to_gateway(monkeypatch):
    monkeypatch.setenv("STEALTH_BROWSER_URL", "http://gateway.test:8080")
    monkeypatch.setenv("STEALTH_BROWSER_TOKEN", "tok")
    params = {"headers": {}, "searxng_locale": "en-US"}
    stealth_google.request("python asyncio", params)
    assert params["url"] == "http://gateway.test:8080/content"
    assert params["method"] == "POST"
    assert params["headers"]["Authorization"] == "Bearer tok"
    assert params["json"] == {
        "url": "https://www.google.com/search?q=python+asyncio&hl=en&num=10",
        "waitForTimeout": 2000,
    }


def test_content_is_the_result_description_not_the_site_label(resolver):
    results = stealth_google.response(fake_response(fixture_page()))
    assert results[0].content.startswith("asyncio is a library to write concurrent code")
    assert "Python documentation" not in results[0].content
    assert "docs.python.org" not in results[0].content
    assert all(r.content for r in results)


def test_empty_title_does_not_space_out_the_snippet(monkeypatch):
    monkeypatch.setattr(stealth_google, "_resolve", lambda path: "https://a.test/")
    page = '<html><body><div><a href="/goto?x"><h3></h3></a><div>hello world</div></div></body></html>'
    results = stealth_google.response(fake_response(page))
    assert results[0].content == "hello world"


def test_zero_results_without_interstitial_logs_a_warning(caplog):
    caplog.set_level(logging.WARNING, logger="searx.engines.stealth_google")
    page = "<html><head><title>Sorry</title></head><body>unusual traffic</body></html>"
    assert len(stealth_google.response(fake_response(page))) == 0
    assert "no results" in caplog.text


@pytest.mark.parametrize("body", ["", "   ", "\n"])
def test_empty_gateway_body_raises_engine_exception(body):
    with pytest.raises(SearxEngineAPIException):
        stealth_google.response(fake_response(body))


@pytest.mark.parametrize("missing", ["STEALTH_BROWSER_URL", "STEALTH_BROWSER_TOKEN"])
def test_missing_env_var_is_named_in_the_error(monkeypatch, missing):
    monkeypatch.setenv("STEALTH_BROWSER_URL", "http://gateway.test:8080")
    monkeypatch.setenv("STEALTH_BROWSER_TOKEN", "tok")
    monkeypatch.delenv(missing)
    with pytest.raises(SearxEngineAPIException, match=missing):
        stealth_google.request("q", {"headers": {}})


def test_module_does_not_shadow_reserved_engine_attributes():
    assert not hasattr(stealth_google, "network")
    assert not hasattr(stealth_google, "logger")
