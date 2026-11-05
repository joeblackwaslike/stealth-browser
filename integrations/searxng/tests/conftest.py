import sys
import types
from dataclasses import dataclass
from pathlib import Path

ENGINES_DIR = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(ENGINES_DIR))


class SearxEngineAPIException(Exception):
    pass


@dataclass
class MainResult:
    url: str
    title: str
    content: str = ""


class EngineResults(list):
    types = types.SimpleNamespace(MainResult=MainResult)

    def add(self, item):
        self.append(item)


def _install_fake_searx():
    searx = types.ModuleType("searx")
    exceptions = types.ModuleType("searx.exceptions")
    exceptions.SearxEngineAPIException = SearxEngineAPIException
    result_types = types.ModuleType("searx.result_types")
    result_types.EngineResults = EngineResults
    network = types.ModuleType("searx.network")
    network.get = lambda *args, **kwargs: (_ for _ in ()).throw(
        AssertionError("tests must not hit the network")
    )
    searx.network = network
    sys.modules.update(
        {
            "searx": searx,
            "searx.exceptions": exceptions,
            "searx.result_types": result_types,
            "searx.network": network,
        }
    )


_install_fake_searx()
