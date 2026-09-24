#!/usr/bin/python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
import json
import os


class PreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory="/app", **kwargs)

    def log_message(self, _format, *_args):
        # Request paths can contain playlist credentials; keep proxy URLs out of logs.
        pass

    def do_GET(self):
        request_url = urlsplit(self.path)
        if request_url.path != "/__provider-proxy":
            return super().do_GET()

        target_value = parse_qs(request_url.query).get("url", [""])[0]
        target = urlsplit(target_value)
        expected_host = os.environ.get("PREVIEW_PROVIDER_HOST", "").lower()
        if (target.scheme not in ("http", "https") or not target.hostname
                or (expected_host and target.hostname.lower() != expected_host)):
            self.send_error(403, "Provider request is not allowed")
            return

        path = target.path.lower()
        basename = path.rsplit("/", 1)[-1]
        if basename not in ("get.php", "player_api.php") and not path.endswith((".m3u", ".m3u8", ".txt")):
            self.send_error(403, "Provider endpoint is not allowed")
            return

        upstream_request = Request(target_value, headers={
            "User-Agent": self.headers.get("User-Agent", "Substream local Chromium 47 preview"),
            "Accept": self.headers.get("Accept", "*/*"),
        })
        parameters = parse_qs(target.query)
        action = parameters.get("action", [""])[0]
        safe_action = action if action in ("get_vod_categories", "get_series_categories", "get_vod_streams", "get_series", "get_series_info") else "playlist"
        try:
            upstream = urlopen(upstream_request, timeout=180)
        except HTTPError as error:
            upstream = error
        except (URLError, TimeoutError, OSError):
            print(f"provider-proxy action={safe_action} status=502", flush=True)
            self.send_error(502, "Provider request failed")
            return

        with upstream:
            if safe_action in ("get_vod_categories", "get_series_categories"):
                body = upstream.read()
                try:
                    payload = json.loads(body)
                    shape = "array" if isinstance(payload, list) else "object" if isinstance(payload, dict) else "other"
                    count = len(payload) if isinstance(payload, list) else 0
                except (json.JSONDecodeError, UnicodeDecodeError):
                    shape = "non-json"
                    count = 0
                print(f"provider-proxy action={safe_action} status={upstream.status} shape={shape} count={count}", flush=True)
                self.send_response(upstream.status)
                self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/octet-stream"))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return

            print(f"provider-proxy action={safe_action} status={upstream.status}", flush=True)
            self.send_response(upstream.status)
            self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/octet-stream"))
            content_length = upstream.headers.get("Content-Length")
            if content_length:
                self.send_header("Content-Length", content_length)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                while True:
                    chunk = upstream.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


ThreadingHTTPServer(("127.0.0.1", 4173), PreviewHandler).serve_forever()
