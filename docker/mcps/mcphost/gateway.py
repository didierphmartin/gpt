"""Gateway: /<folder>/<rest> is forwarded to the hosted server listening on 127.0.0.1:<its port>."""
import http.client
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOP_BY_HOP = {"connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"}
SKIP_RESPONSE = HOP_BY_HOP | {"server", "date"}   # the gateway sends its own
CONNECT_TIMEOUT = 5
CHUNK = 65536


def _hop(name: str) -> bool:
    n = name.lower()
    return n in HOP_BY_HOP or n.startswith("proxy-")


def _chunks(rfile):
    """Decode a chunked request body, yielding the data pieces."""
    while True:
        size = int(rfile.readline().split(b";")[0].strip() or b"0", 16)
        if size == 0:
            while rfile.readline().strip():   # trailers
                pass
            return
        yield rfile.read(size)
        rfile.readline()


def make_server(registry, port=8790, host="0.0.0.0") -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):   # no request logging
            pass

        def _fail(self, status, text):
            data = text.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def _body(self):
            if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
                return _chunks(self.rfile), True
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            return (self.rfile.read(n) if n > 0 else None), False

        def _forward(self):
            parts = urlsplit(self.path)
            folder, _, rest = parts.path.lstrip("/").partition("/")
            entry = registry.get(folder) if folder and parts.path.startswith("/") else None
            if not entry or not entry.get("port"):
                self.close_connection = True   # the request body may be unread
                return self._fail(404, "not found")
            body, chunked = self._body()
            target = "/" + rest + ("?" + parts.query if parts.query else "")
            headers = {k: v for k, v in self.headers.items() if not _hop(k) and k.lower() not in ("host", "content-length")}
            if isinstance(body, bytes):
                headers["Content-Length"] = str(len(body))
            conn = http.client.HTTPConnection("127.0.0.1", entry["port"], timeout=CONNECT_TIMEOUT)
            try:
                try:
                    conn.connect()
                    conn.sock.settimeout(None)   # SSE / streamable HTTP stay open for minutes
                    conn.request(self.command, target, body, headers, encode_chunked=chunked)
                    resp = conn.getresponse()
                except (OSError, http.client.HTTPException):
                    self.close_connection = True
                    return self._fail(502, "server not reachable")
                self._relay(resp)
            finally:
                conn.close()

        def _relay(self, resp):
            has_len = resp.getheader("Content-Length") is not None
            bodiless = self.command == "HEAD" or resp.status in (204, 304) or resp.status < 200
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in SKIP_RESPONSE and not k.lower().startswith("proxy-"):
                    self.send_header(k, v)
            chunk_out = not has_len and not bodiless
            if chunk_out:
                self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            if bodiless:
                return
            try:
                while True:
                    data = resp.read1(CHUNK)
                    if not data:
                        break
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data) if chunk_out else data)
                    self.wfile.flush()
                if chunk_out:
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
                self.close_connection = True   # the client went away
            except (OSError, http.client.HTTPException):
                self.close_connection = True   # the backend died mid-response

        def _route(self):
            try:
                self._forward()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _route

    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    return srv
