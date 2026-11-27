import argparse
import functools
import http.server
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


parser = argparse.ArgumentParser()
parser.add_argument("port", nargs="?", type=int, default=8000)
args = parser.parse_args()
handler = functools.partial(NoCacheHandler, directory=str(Path(__file__).parent / "web"))
print(f"Open http://localhost:{args.port}", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler).serve_forever()
