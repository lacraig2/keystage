"""Local test server for Keystage.

Keystage is a static site: publish the folder (e.g. GitHub Pages) and it just works.
Browsers won't run it from a double-clicked file, though, so for local testing this
serves it on http://localhost:8642. It also offers /fetch?url=... so URL imports work
for sites that block cross-site downloads (on a static host only CORS-friendly links work).

Usage: python serve.py [port] [--no-browser]
"""
import http.server
import socketserver
import sys
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8642)
MAX_BYTES = 10 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/fetch":
            return self.proxy(urllib.parse.parse_qs(parsed.query).get("url", [""])[0])
        return super().do_GET()

    def proxy(self, url):
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            return self.fail(400, "Only http(s) links can be fetched")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Keystage MIDI importer)"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                body = r.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    return self.fail(413, "That file is too large (10 MB limit)")
                self.send_response(200)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/octet-stream"))
                self.send_header("X-Final-Url", r.geturl())
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.fail(502, f"The site answered HTTP {e.code}")
        except Exception as e:  # network errors, timeouts, bad hosts
            self.fail(502, f"Couldn't reach that site ({e.__class__.__name__})")

    def fail(self, code, text):
        data = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    Handler.extensions_map[".js"] = "text/javascript"
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}/"
        print(f"Keystage is live at {url}  (Ctrl+C to stop)")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        httpd.serve_forever()
