"""Exercise Substream's native HTML form flow in Chromium without Google."""

import http.client
import json
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


REPO = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


tls_port, sink_port = free_port(), free_port()
policy = {"value": "no-referrer"}
observed = {"origin": None, "referrer": None}

with tempfile.TemporaryDirectory(prefix="substream-browser-") as temporary:
    folder = Path(temporary)
    origin = f"https://127.0.0.1:{tls_port}"
    config = {
        "googleClientId": "synthetic-client-id",
        "googleClientSecret": "synthetic-client-secret",
        "allowedEmails": ["browser@example.invalid"],
        "portalOrigin": origin,
        "playerOrigin": f"http://127.0.0.1:{sink_port}",
        "databasePath": str(folder / "state.sqlite"),
    }
    (folder / "config.json").write_text(json.dumps(config))
    runner = folder / "runner.mjs"
    runner.write_text(
        f'''import {{createAccessService}} from {json.dumps(str(REPO / 'services/substream-access/service.ts'))};
import {{writeFile}} from 'node:fs/promises';
const service=await createAccessService({{configPath:{json.dumps(str(folder / 'config.json'))},portalPort:0,authPort:0}});await service.listen();
const session=service.store.createSession('browser@example.invalid',Math.floor(Date.now()/1000));
await writeFile({json.dumps(str(folder / 'ready.json'))},JSON.stringify({{port:service.portal.address().port,session:session.id}}),{{mode:0o600}});
process.on('SIGTERM',()=>{{void service.close()}});
'''
    )
    node = subprocess.Popen(
        ["node", str(runner)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    proxy = sink = None
    try:
        ready_file = folder / "ready.json"
        for _ in range(100):
            if ready_file.exists():
                break
            if node.poll() is not None:
                raise RuntimeError("Synthetic service failed to start")
            time.sleep(0.05)
        else:
            raise RuntimeError("Synthetic service did not become ready")
        fixture = json.loads(ready_file.read_text())

        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.forward()

            def do_POST(self):
                observed["origin"] = self.headers.get("Origin")
                self.forward()

            def forward(self):
                length = int(self.headers.get("Content-Length", "0"))
                headers = dict(self.headers)
                headers["Host"] = f"127.0.0.1:{tls_port}"
                headers["X-Real-IP"] = "127.0.0.1"
                connection = http.client.HTTPConnection("127.0.0.1", fixture["port"])
                body = self.rfile.read(length) if length else None
                connection.request(self.command, self.path, body, headers)
                response = connection.getresponse()
                payload = response.read()
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in ("connection", "transfer-encoding", "content-length"):
                        self.send_header(key, value)
                # Mirror the edge proxy's policy header for the before/after check.
                self.send_header("Referrer-Policy", policy["value"])
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                connection.close()

        class Sink(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                observed["referrer"] = self.headers.get("Referer")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"Synthetic player")

        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", str(folder / "key.pem"), "-out", str(folder / "cert.pem"),
                "-days", "1", "-subj", "/CN=localhost",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        proxy = ThreadingHTTPServer(("127.0.0.1", tls_port), Proxy)
        tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_context.load_cert_chain(folder / "cert.pem", folder / "key.pem")
        proxy.socket = tls_context.wrap_socket(proxy.socket, server_side=True)
        sink = ThreadingHTTPServer(("127.0.0.1", sink_port), Sink)
        for server in (proxy, sink):
            threading.Thread(target=server.serve_forever, daemon=True).start()

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                context = browser.new_context(ignore_https_errors=True)
                context.add_cookies(
                    [
                        {
                            "name": "__Host-substream_session",
                            "value": fixture["session"],
                            "url": origin,
                            "secure": True,
                            "httpOnly": True,
                            "sameSite": "Lax",
                        }
                    ]
                )
                page = context.new_page()
                page.goto(origin)
                with page.expect_response(
                    lambda response: response.url == origin + "/access"
                    and response.request.method == "POST"
                ) as response:
                    page.get_by_role("button", name="Create access link").click()
                assert response.value.status == 403 and observed["origin"] == "null"
                print("Reproduced: native form POST sends Origin null under no-referrer and receives 403.")

                policy["value"] = "same-origin"
                page.goto(origin)
                with page.expect_response(
                    lambda item: item.url == origin + "/access"
                    and item.request.method == "POST"
                ) as response:
                    page.get_by_role("button", name="Create access link").click()
                assert response.value.status == 200 and observed["origin"] == origin
                assert page.get_by_role("heading", name="Access link created").is_visible()

                page.get_by_role("link", name="Open Substream", exact=True).click()
                page.wait_for_url(f"http://127.0.0.1:{sink_port}/**")
                assert observed["referrer"] is None

                page.goto(origin)
                with page.expect_response(
                    lambda item: item.url == origin + "/access/revoke"
                    and item.request.method == "POST"
                ) as response:
                    page.get_by_role("button", name="Revoke access").click()
                assert response.value.status == 303 and observed["origin"] == origin
                page.wait_for_url(origin + "/")

                with page.expect_response(
                    lambda item: item.url == origin + "/logout"
                    and item.request.method == "POST"
                ) as response:
                    page.get_by_role("button", name="Sign out").click()
                assert response.value.status == 303 and observed["origin"] == origin
                print("Fixed flow passed: create, HTTP navigation without Referer, revoke and logout.")
            finally:
                browser.close()
    finally:
        for server in (proxy, sink):
            if server:
                server.shutdown()
                server.server_close()
        node.terminate()
        node.wait(timeout=10)
