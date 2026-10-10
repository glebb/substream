#!/usr/bin/env python3
"""Exercise the Substream HTTP player gate and HTTPS access portal.

Run on Linux with Nginx installed:

    python3 scripts/substream-web-integration.py

The harness creates an isolated Nginx prefix and binds HTTP, HTTPS,
authorization and portal listeners to loopback. It uses a synthetic
43-character token, synthetic client IPs, a temporary self-signed TLS
certificate and generated fixtures. It never contacts a provider or reads .env.
Temporary files, the fake authorizer, and Nginx are cleaned up on exit.
"""

from __future__ import annotations

import argparse
import glob
import http.client
import ipaddress
import os
from pathlib import Path
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


TOKEN = "A" * 43
AUTHORIZED_IP = "127.0.0.1"
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000b49444154789c636000020000050001a5f645400000000049454e44ae426082"
)
WASM_HEADER = b"\x00asm\x01\x00\x00\x00"


class SyntheticAuthorizer(BaseHTTPRequestHandler):
    token = TOKEN
    client_ip = AUTHORIZED_IP
    request_count = 0
    invalid_request = None

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        type(self).request_count += 1
        original_uri = self.headers.get("X-Substream-Original-URI", "")
        client_ip = self.headers.get("X-Substream-Client-IP", "")
        has_forbidden_headers = bool(
            self.headers.get("Cookie")
            or self.headers.get("Authorization")
            or self.headers.get("Content-Length")
        )
        if self.command != "GET" or has_forbidden_headers:
            type(self).invalid_request = "auth subrequest forwarded method, body, or credentials"
        path = urlsplit(original_uri).path
        allowed = (
            path.startswith(f"/{type(self).token}/")
            and client_ip == type(self).client_ip
        )
        self.send_response(204 if allowed else 403)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def log_message(self, _format: str, *_args: object) -> None:
        # Keep request paths and synthetic tokens out of test logs too.
        pass


class SyntheticGuide(BaseHTTPRequestHandler):
    requests: list[dict[str, object]] = []

    def do_GET(self) -> None:
        type(self).requests.append({"path": self.path, "headers": dict(self.headers),
                                    "body_length": self.headers.get("Content-Length", "")})
        body = b"synthetic public guide"
        self.send_response(200)
        self.send_header("Content-Type", "application/gzip")
        self.send_header("Set-Cookie", "upstream=synthetic")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


class SyntheticPortal(BaseHTTPRequestHandler):
    requests: list[tuple[str, str, str, str]] = []

    def _respond(self) -> None:
        type(self).requests.append((
            self.command,
            self.path,
            self.headers.get("X-Real-IP", ""),
            self.headers.get("X-Forwarded-For", ""),
        ))
        body = b"synthetic portal"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Set-Cookie", "session=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._respond()

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._respond()

    def log_message(self, _format: str, *_args: object) -> None:
        pass


def available_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def make_synthetic_dist(destination: Path) -> None:
    (destination / "assets").mkdir(parents=True)
    (destination / "branding").mkdir()
    (destination / "index.html").write_text(
        "<!doctype html><meta charset=utf-8>"
        '<link rel="stylesheet" href="./assets/site.css">'
        '<script type="module" src="./assets/app.js"></script>'
        '<img src="./branding/icon.png">',
        encoding="utf-8",
    )
    (destination / "assets" / "app.js").write_text(
        'new Worker("./worker.js");', encoding="utf-8"
    )
    (destination / "assets" / "site.css").write_text(
        "body { color: #123; }", encoding="utf-8"
    )
    (destination / "assets" / "worker.js").write_text(
        "self.onmessage = () => {};", encoding="utf-8"
    )
    (destination / "assets" / "decoder.wasm").write_bytes(WASM_HEADER)
    (destination / "branding" / "icon.png").write_bytes(PNG_1X1)


def run(args: argparse.Namespace) -> None:
    bind_ip = str(ipaddress.ip_address(args.host))
    if not ipaddress.ip_address(bind_ip).is_loopback or ":" in bind_ip:
        raise ValueError("--host must be an IPv4 loopback address")
    if sys.platform != "linux":
        raise RuntimeError("This integration harness is intended for Linux Nginx")

    nginx = shutil.which(args.nginx) or args.nginx
    template_path = Path(args.template).resolve()
    if not template_path.is_file():
        raise FileNotFoundError(f"Nginx template not found: {template_path}")
    dist_source = Path(args.dist).resolve() if args.dist else None
    if dist_source is not None and not (dist_source / "index.html").is_file():
        raise FileNotFoundError(f"dist must contain index.html: {dist_source}")

    http_port = args.port or available_port(bind_ip)
    auth_port = args.auth_port or available_port(bind_ip)
    https_port = args.https_port or available_port(bind_ip)
    portal_port = args.portal_port or available_port(bind_ip)
    guide_port = available_port(bind_ip)
    if len({http_port, https_port, auth_port, portal_port}) != 4:
        raise ValueError("HTTP, HTTPS, authorization and portal ports must differ")

    temporary_root = Path(tempfile.mkdtemp(prefix="substream-nginx-integration-"))
    # Root-run Nginx drops worker privileges on many Linux hosts. Keep fixture
    # trees traversable/readable just like the installed 0555/0444 releases.
    os.chmod(temporary_root, 0o755)
    auth_server: ThreadingHTTPServer | None = None
    auth_thread: threading.Thread | None = None
    portal_server: ThreadingHTTPServer | None = None
    portal_thread: threading.Thread | None = None
    guide_server: ThreadingHTTPServer | None = None
    guide_thread: threading.Thread | None = None
    nginx_started = False
    config_path = temporary_root / "nginx.conf"
    pid_path = temporary_root / "nginx.pid"

    try:
        dist_path = temporary_root / "www"
        if dist_source is None:
            dist_path.mkdir()
            make_synthetic_dist(dist_path)
        else:
            shutil.copytree(dist_source, dist_path)
        acme_path = temporary_root / "acme-webroot"
        challenge_path = acme_path / ".well-known" / "acme-challenge"
        challenge_path.mkdir(parents=True)
        acme_payload = "synthetic-acme-proof\n"
        (challenge_path / "synthetic-challenge").write_text(acme_payload, encoding="utf-8")

        certificate = temporary_root / "portal-cert.pem"
        private_key = temporary_root / "portal-key.pem"
        generated_cert = subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", str(private_key), "-out", str(certificate),
                "-days", "1", "-subj", "/CN=localhost",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        if generated_cert.returncode:
            raise RuntimeError("could not generate temporary portal TLS certificate")

        site = template_path.read_text(encoding="utf-8")
        replacements = (
            ("https://epgshare01.online/epgshare01/epg_ripper_SE1.xml.gz", f"http://{bind_ip}:{guide_port}/epgshare01/epg_ripper_SE1.xml.gz"),
            ("listen 80;", f"listen {bind_ip}:{http_port};"),
            ("listen 443 ssl;", f"listen {bind_ip}:{https_port} ssl;"),
            ("server_name substream.example.invalid;", "server_name localhost;"),
            ("root /opt/substream-web/current;", f"root {dist_path};"),
            ("root /var/lib/substream-access-acme;", f"root {acme_path};"),
            ("http://127.0.0.1:8791/authorize", f"http://{bind_ip}:{auth_port}/authorize"),
            ("http://127.0.0.1:8792", f"http://{bind_ip}:{portal_port}"),
            ("https://substream.example.invalid", f"https://localhost:{https_port}"),
            ("http://substream.example.invalid", f"http://localhost:{http_port}"),
            ("/etc/letsencrypt/live/substream.example.invalid/fullchain.pem", str(certificate)),
            ("/etc/letsencrypt/live/substream.example.invalid/privkey.pem", str(private_key)),
        )
        for old, new in replacements:
            count = site.count(old)
            expected_count = {
                "server_name substream.example.invalid;": 2,
                "listen 80;": 1,
                "listen 443 ssl;": 1,
                "root /opt/substream-web/current;": 1,
                "root /var/lib/substream-access-acme;": 1,
                "http://127.0.0.1:8791/authorize": 1,
                "/etc/letsencrypt/live/substream.example.invalid/fullchain.pem": 1,
                "/etc/letsencrypt/live/substream.example.invalid/privkey.pem": 1,
            }.get(old)
            if expected_count is not None and count != expected_count:
                raise ValueError(f"Expected {expected_count} Nginx template occurrence(s) for {old!r}")
            if count == 0:
                raise ValueError(f"Nginx template does not contain {old!r}")
            site = site.replace(old, new)
        site_path = temporary_root / "site.conf"
        site_path.write_text(site, encoding="utf-8")
        config_path.write_text(
            "\n".join(
                [
                    "worker_processes 1;",
                    f"pid {pid_path};",
                    f"error_log {temporary_root / 'nginx-error.log'};",
                    "events { worker_connections 64; }",
                    "http {",
                    "  include /etc/nginx/mime.types;",
                    "  default_type application/octet-stream;",
                    f"  include {site_path};",
                    "}",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        auth_server = ThreadingHTTPServer((bind_ip, auth_port), SyntheticAuthorizer)
        auth_server.daemon_threads = True
        auth_thread = threading.Thread(target=auth_server.serve_forever, daemon=True)
        auth_thread.start()
        portal_server = ThreadingHTTPServer((bind_ip, portal_port), SyntheticPortal)
        portal_server.daemon_threads = True
        portal_thread = threading.Thread(target=portal_server.serve_forever, daemon=True)
        portal_thread.start()

        guide_server = ThreadingHTTPServer((bind_ip, guide_port), SyntheticGuide)
        guide_server.daemon_threads = True
        guide_thread = threading.Thread(target=guide_server.serve_forever, daemon=True)
        guide_thread.start()

        command = [nginx, "-p", f"{temporary_root}/", "-c", str(config_path)]
        checked = subprocess.run(
            [nginx, "-t", "-p", f"{temporary_root}/", "-c", str(config_path)],
            text=True,
            capture_output=True,
            check=False,
        )
        if checked.stdout.strip():
            print(checked.stdout.strip())
        if checked.stderr.strip():
            print(checked.stderr.strip())
        if checked.returncode:
            raise RuntimeError("nginx -t rejected the isolated template")
        started = subprocess.run(command, text=True, capture_output=True, check=False)
        if started.returncode:
            raise RuntimeError("Nginx failed to start in the temporary prefix")
        nginx_started = True

        tls_context = ssl._create_unverified_context()

        def request(
            path: str,
            source_ip: str = AUTHORIZED_IP,
            use_https: bool = False,
            method: str = "GET",
            headers: dict[str, str] | None = None,
        ) -> tuple[int, str, int, dict[str, str]]:
            connection = (
                http.client.HTTPSConnection(
                    bind_ip, https_port, timeout=4, source_address=(source_ip, 0),
                    context=tls_context,
                )
                if use_https
                else http.client.HTTPConnection(
                    bind_ip, http_port, timeout=4, source_address=(source_ip, 0)
                )
            )
            try:
                connection.request(method, path, headers=headers or {})
                response = connection.getresponse()
                body = response.read()
                return (
                    response.status,
                    response.getheader("Content-Type", ""),
                    len(body),
                    {key.lower(): value for key, value in response.getheaders()},
                )
            finally:
                connection.close()

        def check(
            label: str,
            expected: int,
            path: str,
            source_ip: str = AUTHORIZED_IP,
            use_https: bool = False,
        ) -> tuple[str, int]:
            last_error: Exception | None = None
            for _ in range(20):
                try:
                    status, content_type, size, _headers = request(path, source_ip, use_https)
                    break
                except OSError as error:
                    last_error = error
                    time.sleep(0.1)
            else:
                raise RuntimeError(f"Nginx did not accept requests: {last_error}")
            print(f"{label}: {status} {content_type} ({size} bytes)")
            if status != expected:
                raise AssertionError(
                    f"{label}: expected HTTP {expected}, got {status}"
                )
            return content_type, size

        root_status, _root_type, _root_size, root_headers = request("/")
        if root_status != 301 or root_headers.get("location") != f"https://localhost:{https_port}/":
            raise AssertionError("HTTP root should redirect to the HTTPS portal")
        print(f"HTTP portal root redirect: {root_status}")
        acme_status, acme_type, acme_size, _acme_headers = request(
            "/.well-known/acme-challenge/synthetic-challenge"
        )
        if acme_status != 200 or acme_size != len(acme_payload.encode("utf-8")):
            raise AssertionError(
                f"HTTP ACME webroot failed with {acme_status} {acme_type} ({acme_size} bytes)"
            )
        print(f"HTTP ACME webroot: {acme_status} {acme_type} ({acme_size} bytes)")
        for tls in (False, True):
            status, _, size, headers = request("/public/nordic-epg", use_https=tls,
                headers={"Cookie": "synthetic-cookie", "Authorization": "Bearer synthetic-token",
                         "X-Provider-Key": "synthetic-key", "Referer": "https://private.example.invalid/"})
            if status != 200 or size != len(b"synthetic public guide") or "set-cookie" in headers:
                raise AssertionError("public guide response failed")
            upstream = SyntheticGuide.requests[-1]
            if upstream["path"] != "/epgshare01/epg_ripper_SE1.xml.gz":
                raise AssertionError("public guide destination changed")
            upstream_headers = {k.lower(): v for k, v in upstream["headers"].items()}
            if any(k in upstream_headers for k in ("cookie", "authorization", "x-provider-key", "referer")):
                raise AssertionError("public guide forwarded caller credentials")
            check("public guide rejects query", 400, "/public/nordic-epg?url=synthetic", use_https=tls)
            if request("/public/nordic-epg", use_https=tls, method="POST")[0] != 403:
                raise AssertionError("public guide must reject request bodies")
        print("Public guide HTTP/HTTPS routes and credential stripping passed.")
        check("protected index", 200, f"/{TOKEN}/")
        classes = (
            ("JavaScript", "assets/*.js"),
            ("CSS", "assets/*.css"),
            ("worker", "assets/*worker*.js"),
            ("WASM", "assets/*.wasm"),
            ("image", "branding/*.png"),
        )
        for label, pattern in classes:
            matches = glob.glob(str(dist_path / pattern))
            if not matches:
                raise AssertionError(f"static fixture lacks {label} file class")
            asset = Path(matches[0]).relative_to(dist_path).as_posix()
            check(label, 200, f"/{TOKEN}/{asset}")
        check("unknown token", 403, f"/{'B' * 43}/")
        check("wrong source IP", 403, f"/{TOKEN}/", "127.0.0.2")
        javascript_matches = glob.glob(str(dist_path / "assets/*.js"))
        javascript = Path(javascript_matches[0]).relative_to(dist_path).as_posix()
        denied_type, _ = check(
            "wrong-IP JavaScript", 403, f"/{TOKEN}/{javascript}", "127.0.0.2"
        )
        if not denied_type.lower().startswith("text/html"):
            raise AssertionError(
                "denied asset body must not retain its JavaScript content type"
            )
        check("token API", 404, f"/{TOKEN}/api/catalog")
        check("provider proxy path", 404, f"/{TOKEN}/__provider-proxy")
        check("raw root asset", 404, "/assets/app.js")
        check("public internal endpoint", 404, "/_substream_authorize")
        check("encoded traversal", 404, f"/{TOKEN}/%2e%2e/etc/passwd")
        check("double-encoded traversal", 404, f"/{TOKEN}/%252e%252e/etc/passwd")
        check("encoded slash traversal", 404, f"/{TOKEN}/%2fetc/passwd")
        check("malformed token length", 404, "/short-token/")

        for path in (
            "/auth/google/login",
            "/auth/google/callback?state=synthetic",
            "/access",
            "/access/revoke",
            "/logout",
            "/branding/substream-icon.png",
        ):
            status, _content_type, _size, headers = request(path)
            location = headers.get("location", "")
            if status != 308 or not location.startswith(f"https://localhost:{https_port}"):
                raise AssertionError(f"HTTP portal route did not redirect to HTTPS: {path}")
            print(f"HTTP portal redirect {path.split('?')[0]}: {status}")
        for path in ("/access", "/access/revoke", "/logout"):
            status, _content_type, _size, headers = request(path, method="POST")
            if status != 308 or not headers.get("location", "").startswith(f"https://localhost:{https_port}"):
                raise AssertionError(f"HTTP portal POST did not retain its HTTPS redirect: {path}")
            print(f"HTTP portal POST redirect {path}: {status}")

        allowed_portal_routes = (
            ("GET", "/"),
            ("GET", "/auth/google/login"),
            ("GET", "/auth/google/callback?state=synthetic"),
            ("POST", "/access"),
            ("POST", "/access/revoke"),
            ("POST", "/logout"),
            ("GET", "/branding/substream-icon.png"),
        )
        for method, path in allowed_portal_routes:
            status, _content_type, _size, headers = request(
                path,
                use_https=True,
                method=method,
                headers={"X-Real-IP": "203.0.113.99", "X-Forwarded-For": "198.51.100.8"},
            )
            if status != 200:
                raise AssertionError(f"HTTPS portal route failed: {method} {path}")
            if headers.get("referrer-policy") != "same-origin":
                raise AssertionError("HTTPS portal must preserve same-origin form Origin while suppressing cross-origin referrers")
            cookie = headers.get("set-cookie", "")
            if "Secure" not in cookie or "Domain=" in cookie:
                raise AssertionError("portal cookie lost Secure or gained a Domain attribute")
            if "strict-transport-security" in headers:
                raise AssertionError("Substream must not emit HSTS")
            if "upgrade-insecure-requests" in headers.get("content-security-policy", ""):
                raise AssertionError("portal CSP must not upgrade HTTP player requests")
            print(f"HTTPS portal route {method} {path.split('?')[0]}: {status}")
        for method in ("GET", "HEAD"):
            path = "/" + "x" * 43 + "/"
            status, _, _, headers = request(path + "?discard=synthetic", use_https=True, method=method)
            if status != 302 or headers.get("location") != f"http://localhost:{http_port}{path}":
                raise AssertionError("HTTPS player landing link must redirect to the HTTP gate without query data")
            if headers.get("referrer-policy") != "no-referrer" or headers.get("cache-control") != "no-store":
                raise AssertionError("player landing redirects must suppress referrers and caching")
            if request(path)[0] != 403:
                raise AssertionError("redirected unknown grants must remain denied by the HTTP gate")
        for path in ("/" + "x" * 42 + "/", "/" + "x" * 43 + "/assets/app.js", "/" + "x" * 43 + "/api/"):
            if request(path, use_https=True)[0] != 404:
                raise AssertionError("HTTPS redirect must be limited to well-shaped player landing links")
        if request("/" + "x" * 43 + "/", use_https=True, method="POST")[0] != 403:
            raise AssertionError("HTTPS player landing redirects must reject mutation methods")

        if request("/not-allowlisted", use_https=True)[0] != 404:
            raise AssertionError("HTTPS non-allowlisted route should return 404")
        if request("/access", use_https=True)[0] != 403:
            raise AssertionError("HTTPS access route should reject GET")
        if request("/logout", use_https=True, method="GET")[0] != 403:
            raise AssertionError("HTTPS logout route should reject GET")
        if any(real_ip != AUTHORIZED_IP or forwarded != AUTHORIZED_IP
               for _, _, real_ip, forwarded in SyntheticPortal.requests):
            raise AssertionError("portal proxy did not overwrite client IP headers")
        print("HTTPS allowlist, methods, cookies and client-IP forwarding passed")

        if SyntheticAuthorizer.invalid_request:
            raise AssertionError(SyntheticAuthorizer.invalid_request)
        if SyntheticAuthorizer.request_count < 8:
            raise AssertionError("expected every protected file request to authorize")

        auth_server.shutdown()
        auth_thread.join(timeout=3)
        auth_server.server_close()
        auth_server = None
        status, content_type, size, _headers = request(f"/{TOKEN}/")
        print(f"authorizer unavailable: {status} {content_type} ({size} bytes)")
        if status < 500:
            raise AssertionError(f"authorizer failure must fail closed, got {status}")
        print("Nginx Substream integration matrix passed.")
    finally:
        if auth_server is not None:
            auth_server.shutdown()
            auth_server.server_close()
        if auth_thread is not None:
            auth_thread.join(timeout=3)
        if portal_server is not None:
            portal_server.shutdown()
            portal_server.server_close()
        if portal_thread is not None:
            portal_thread.join(timeout=3)
        if guide_server is not None:
            guide_server.shutdown()
            guide_server.server_close()
        if guide_thread is not None:
            guide_thread.join(timeout=3)
        if nginx_started:
            subprocess.run(
                [nginx, "-p", f"{temporary_root}/", "-c", str(config_path), "-s", "quit"],
                text=True,
                capture_output=True,
                check=False,
                timeout=5,
            )
            deadline = time.monotonic() + 5
            while pid_path.exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            if pid_path.exists():
                try:
                    os.kill(int(pid_path.read_text().strip()), signal.SIGTERM)
                except (OSError, ValueError):
                    pass
        shutil.rmtree(temporary_root, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nginx", default="nginx", help="Nginx executable")
    parser.add_argument("--template", default="deploy/substream-web/nginx.conf")
    parser.add_argument("--dist", help="Optional static dist directory; synthetic fixture is default")
    parser.add_argument("--host", default="127.0.0.1", help="Loopback bind address")
    parser.add_argument("--port", type=int, default=0, help="HTTP port; 0 selects an available port")
    parser.add_argument("--auth-port", type=int, default=0, help="Auth port; 0 selects an available port")
    parser.add_argument("--https-port", type=int, default=0, help="HTTPS port; 0 selects an available port")
    parser.add_argument("--portal-port", type=int, default=0, help="Portal port; 0 selects an available port")
    args = parser.parse_args()
    try:
        run(args)
    except Exception as error:
        print(f"integration harness failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
