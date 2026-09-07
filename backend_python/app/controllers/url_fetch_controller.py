"""Port of Controllers/UrlFetchController.php.

URL Fetch Controller

Server-side URL fetcher for skills running in Pyodide. Browser-Python cannot
perform cross-origin XHR for sites without CORS headers (which is virtually
every production site), so the frontend's skill dispatcher intercepts URL
arguments and routes them through this endpoint instead. The fetched HTML is
then written into Pyodide's virtual FS as a file the skill script reads
normally.

Security:
  - Blocks non-http(s) schemes.
  - Blocks loopback / private / link-local IPs to prevent SSRF against
    internal infrastructure.
  - Caps response body at MAX_BYTES so a malicious target can't fill memory.
  - 30s timeout — long enough for slow blogs, short enough to avoid hangs.

Returns gzip/deflate-decompressed HTML decoded as a UTF-8 string (httpx
auto-decompresses, same as curl's CURLOPT_ENCODING => ''). The caller doesn't
need to handle Content-Encoding.
"""
from __future__ import annotations

import re
import socket
from urllib.parse import urlsplit

import httpx
from ipaddress import ip_address

from app.providers._http import SHARED_SSL_CONTEXT
from app.support.phpcompat import php_empty, php_strval

_BARE_DOMAIN_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')
_SCHEME_RE = re.compile(r'^https?://', re.IGNORECASE)
_CHARSET_HEADER_RE = re.compile(r'charset=([\w\-]+)', re.IGNORECASE)
_CHARSET_META_RE = re.compile(rb'<meta[^>]+charset=["\']?([\w\-]+)', re.IGNORECASE)


class UrlFetchController:
    MAX_BYTES = 5 * 1024 * 1024  # 5 MB
    TIMEOUT_SECONDS = 30
    CONNECT_TIMEOUT_SECONDS = 10
    MAX_REDIRECTS = 5
    BROWSER_UA = (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )
    REQUEST_HEADERS = {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    }

    def __init__(self, db, config):
        # No DB or config needed — pure HTTP fetcher.
        self.db = db
        self.config = config

    def fetch(self, request) -> dict:
        """POST /api/v1/fetch-url

        Body: { "url": "https://example.com/article" }
          - Bare domains (e.g. "example.com") are auto-prepended with "https://".

        Returns:
          { success: true,  data: { url, final_url, status, content_type, bytes, html } }
          { success: false, error, status_code }
        """
        body = request.get('body') if request.get('body') is not None else {}
        rawUrl = body.get('url') if isinstance(body, dict) else None
        url = php_strval(rawUrl).strip() if (isinstance(body, dict) and 'url' in body and rawUrl is not None) else ''

        if url == '':
            return {'success': False, 'error': 'Missing required field: url', 'status_code': 400}

        # Auto-prepend https:// for bare domains.
        if not _SCHEME_RE.match(url):
            if self._looksLikeBareDomain(url):
                url = 'https://' + url
            else:
                return {'success': False, 'error': 'Input is not a URL or recognizable domain', 'status_code': 400}

        try:
            parts = urlsplit(url)
            host = parts.hostname
        except ValueError:
            # PHP: parse_url() returns false on malformed URLs (e.g. bad
            # IPv6 literal) -> the `!$parts` branch, same 400 as empty host.
            host = None
        if php_empty(host):
            return {'success': False, 'error': 'Invalid URL', 'status_code': 400}

        # SSRF guard — block loopback, private, link-local, multicast.
        #
        # Exception: if the HTTP request to THIS endpoint came from a loopback
        # address (i.e. the caller is on the same machine as this server, as
        # happens in local XAMPP dev), bypass the guard. The SSRF threat
        # model is "attacker on the public internet probes the server's
        # internal network" — that threat doesn't exist when the attacker
        # would already have full local-machine access. remote_addr is set
        # from the TCP socket and cannot be spoofed.
        if not self._callerIsLoopback(request) and self._isPrivateHost(host):
            return {
                'success': False,
                'error': 'Refusing to fetch from a private/internal address',
                'status_code': 403,
            }

        client = None
        buf = b''
        finalUrl = url
        httpCode = None
        contentType = ''
        try:
            client = self._makeClient()
            try:
                # Passed per-request (not only baked into the client from
                # _makeClient) so a caller providing its own client via
                # _makeClient still gets the browser UA / Accept headers.
                with client.stream('GET', url, headers=self.REQUEST_HEADERS) as r:
                    finalUrl = str(r.url)
                    httpCode = r.status_code
                    contentType = r.headers.get('content-type') or ''
                    for chunk in r.iter_bytes():
                        buf += chunk
                        if len(buf) > self.MAX_BYTES:
                            break
            except httpx.HTTPError as e:
                if len(buf) <= self.MAX_BYTES:
                    return {
                        'success': False,
                        'error': f'Fetch failed (httpx {type(e).__name__}): {e}',
                        'status_code': 502,
                    }
        finally:
            if client is not None:
                client.close()

        if len(buf) > self.MAX_BYTES:
            return {
                'success': False,
                'error': f'Response exceeded {self.MAX_BYTES} bytes',
                'status_code': 502,
            }

        if httpCode is None or httpCode < 200 or httpCode >= 400:
            # Upstream returned a non-2xx (404, 503, etc.). This is the
            # target's own response — not a gateway failure on our end — so
            # return our own 200 OK with success:false and the upstream
            # status in `data.upstream_status`. The previous 502 mapping
            # caused noisy "Bad Gateway" entries in the browser console for
            # every /robots.txt or /llms.txt 404, which skill scripts
            # already handle gracefully via the `success` flag.
            return {
                'success': False,
                'error': f'Upstream returned HTTP {httpCode}',
                'data': {
                    'upstream_status': httpCode,
                    'final_url': finalUrl,
                },
            }

        html = self._decodeBody(buf, contentType)

        return {
            'success': True,
            'data': {
                'url': url,
                'final_url': finalUrl,
                'status': httpCode,
                'content_type': contentType,
                'bytes': len(buf),
                'html': html,
            },
        }

    def _makeClient(self) -> httpx.Client:
        return httpx.Client(
            follow_redirects=True,
            max_redirects=self.MAX_REDIRECTS,
            timeout=httpx.Timeout(self.TIMEOUT_SECONDS, connect=self.CONNECT_TIMEOUT_SECONDS),
            verify=SHARED_SSL_CONTEXT,
            headers=self.REQUEST_HEADERS,
        )

    def _resolve(self, host: str) -> list[str]:
        """Resolve host to its unique IPs. Empty list on failure — don't
        block the fetch on a DNS lookup failure (PHP: same comment)."""
        try:
            infos = socket.getaddrinfo(host, None)
        except OSError:
            return []
        ips: list[str] = []
        seen: set[str] = set()
        for info in infos:
            ip = info[4][0]
            if ip not in seen:
                seen.add(ip)
                ips.append(ip)
        return ips

    def _looksLikeBareDomain(self, s: str) -> bool:
        """True for strings like "example.com" or "www.foo.org/path" — at
        least one dot, alphanumeric/dash/dot only, TLD >= 2 chars.
        Conservative on purpose to avoid false positives on file paths or
        random tokens."""
        if '@' in s or s.startswith('/') or s.startswith('./') or s.startswith('../'):
            return False
        host = s.split('/', 1)[0]
        parts = host.split('.')
        if len(parts) < 2 or len(parts[-1]) < 2:
            return False
        return bool(_BARE_DOMAIN_RE.match(host))

    def _isPrivateHost(self, host: str) -> bool:
        """Block loopback, private (RFC1918), link-local, and multicast
        addresses. Resolves the hostname and checks every returned A/AAAA — a
        single private address among multiple is enough to refuse."""
        ips = self._resolve(host)
        if not ips:
            # Couldn't resolve — let the fetch handle it. Don't block on DNS failure.
            return False
        return any(self._isPrivateIp(ip) for ip in ips)

    def _isPrivateIp(self, ip: str) -> bool:
        try:
            addr = ip_address(ip)
        except ValueError:
            return False
        return bool(addr.is_private or addr.is_reserved or addr.is_loopback or addr.is_link_local or addr.is_multicast)

    def _callerIsLoopback(self, request) -> bool:
        """True when the HTTP request to this endpoint came from a loopback
        address. Used to bypass the SSRF guard for same-machine callers
        (local XAMPP dev). remote_addr is set from the actual TCP connection
        and cannot be spoofed by the client."""
        remote = request.get('remote_addr') or ''
        if remote == '':
            return False
        if remote.startswith('127.'):
            return True
        if remote == '::1':
            return True
        # Some setups encode IPv6-mapped IPv4 as ::ffff:127.x.x.x
        if remote.startswith('::ffff:127.'):
            return True
        return False

    def _decodeBody(self, body: bytes, contentType: str) -> str:
        """Decode the response body using charset hint from Content-Type,
        falling back to <meta charset> sniff in the first 4 KB, then UTF-8."""
        charset = None
        m = _CHARSET_HEADER_RE.search(contentType)
        if m:
            charset = m.group(1).lower()
        if not charset:
            head = body[:4096]
            m2 = _CHARSET_META_RE.search(head)
            if m2:
                charset = m2.group(1).decode('ascii', errors='ignore').lower()
        if not charset or charset in ('utf-8', 'utf8'):
            return body.decode('utf-8', errors='replace')
        try:
            return body.decode(charset, errors='ignore')
        except LookupError:
            return body.decode('utf-8', errors='replace')
