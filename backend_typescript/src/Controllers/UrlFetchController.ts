import http from 'http';
import https from 'https';
import zlib from 'zlib';
import net from 'net';
import dns from 'dns';
import { URL } from 'url';
import iconv from 'iconv-lite';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * Mirrors src/Controllers/UrlFetchController.php.
 *
 * Server-side URL fetcher for skills running in Pyodide (browser-Python can't do cross-origin XHR
 * against non-CORS sites). Returns gzip/deflate/br-decompressed HTML decoded to a UTF-8 string.
 *
 * Security:
 *   - Blocks non-http(s) schemes.
 *   - Blocks loopback / private / link-local IPs (SSRF), UNLESS the caller itself is loopback
 *     (same-machine dev), matching PHP's REMOTE_ADDR bypass.
 *   - Caps the (decompressed) body at MAX_BYTES.
 *   - 30s timeout.
 *
 * Faithful-divergence notes (curl → Node http/https):
 *   - Transport-failure message text differs from PHP's "Fetch failed (curl errno N): ...". Status
 *     (502) and the { success:false, error, status_code } shape are preserved.
 *   - Max redirects is honored at 5 (like CURLOPT_MAXREDIRS). TLS verification is disabled to mirror
 *     CURLOPT_SSL_VERIFYPEER=false. "deflate" is treated as zlib-wrapped (Node createInflate); raw
 *     deflate is not separately retried.
 */
export class UrlFetchController {
  private static readonly MAX_BYTES = 5 * 1024 * 1024; // 5 MB
  private static readonly TIMEOUT_SECONDS = 30;
  private static readonly CONNECT_TIMEOUT_SECONDS = 10;
  private static readonly MAX_REDIRECTS = 5;
  private static readonly BROWSER_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  /** POST /api/v1/fetch-url */
  async fetch(ctx: Ctx): Promise<ControllerResult> {
    const body: any = ctx.body ?? {};
    let url = body.url !== undefined && body.url !== null ? String(body.url).trim() : '';

    if (url === '') {
      return { success: false, error: 'Missing required field: url', status_code: 400 };
    }

    // Auto-prepend https:// for bare domains.
    if (!/^https?:\/\//i.test(url)) {
      if (this.looksLikeBareDomain(url)) {
        url = 'https://' + url;
      } else {
        return { success: false, error: 'Input is not a URL or recognizable domain', status_code: 400 };
      }
    }

    let parts: URL;
    try {
      parts = new URL(url);
    } catch {
      return { success: false, error: 'Invalid URL', status_code: 400 };
    }
    if (!parts.hostname) {
      return { success: false, error: 'Invalid URL', status_code: 400 };
    }

    // SSRF guard — bypassed for loopback callers (local dev), same as PHP.
    if (!this.callerIsLoopback(ctx) && (await this.isPrivateHost(parts.hostname))) {
      return {
        success: false,
        error: 'Refusing to fetch from a private/internal address',
        status_code: 403,
      };
    }

    const result = await this.httpGet(url);

    if (!result.ok && !result.exceeded && result.body.length <= UrlFetchController.MAX_BYTES) {
      return {
        success: false,
        error: `Fetch failed: ${result.error ?? 'transport error'}`,
        status_code: 502,
      };
    }
    if (result.exceeded || result.body.length > UrlFetchController.MAX_BYTES) {
      return {
        success: false,
        error: 'Response exceeded ' + UrlFetchController.MAX_BYTES + ' bytes',
        status_code: 502,
      };
    }

    const httpCode = result.httpCode;
    if (httpCode < 200 || httpCode >= 400) {
      // Upstream's own non-2xx response — not a gateway failure. Return 200 OK with success:false
      // and the upstream status in data.upstream_status (mirrors PHP).
      return {
        success: false,
        error: `Upstream returned HTTP ${httpCode}`,
        data: {
          upstream_status: httpCode,
          final_url: result.finalUrl,
        },
      };
    }

    const html = this.decodeBody(result.body, result.contentType);

    return {
      success: true,
      data: {
        url,
        final_url: result.finalUrl,
        status: httpCode,
        content_type: result.contentType,
        bytes: result.body.length,
        html,
      },
    };
  }

  /**
   * True for strings like "example.com" or "www.foo.org/path" — at least one dot,
   * alphanumeric/dash/dot only, TLD >= 2 chars. Conservative to avoid false positives.
   */
  private looksLikeBareDomain(s: string): boolean {
    if (s.includes('@') || s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) {
      return false;
    }
    const host = s.split('/', 1)[0];
    const parts = host.split('.');
    if (parts.length < 2 || parts[parts.length - 1].length < 2) {
      return false;
    }
    return /^[a-zA-Z0-9.\-]+$/.test(host);
  }

  /**
   * Block loopback, private (RFC1918), and link-local addresses. Resolves the hostname and checks
   * every returned A/AAAA — a single private address is enough to refuse. Mirrors PHP isPrivateHost.
   */
  private async isPrivateHost(host: string): Promise<boolean> {
    // Direct IP literals.
    if (net.isIP(host)) {
      return this.isPrivateIp(host);
    }
    const ips: string[] = [];
    try {
      const v4 = await dns.promises.resolve4(host);
      ips.push(...v4);
    } catch {
      /* no A records */
    }
    try {
      const v6 = await dns.promises.resolve6(host);
      ips.push(...v6);
    } catch {
      /* no AAAA records */
    }
    if (ips.length === 0) {
      // Couldn't resolve — let the fetch handle it. Don't block on DNS failure.
      return false;
    }
    for (const ip of ips) {
      if (this.isPrivateIp(ip)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Mirrors PHP filter_var($ip, FILTER_VALIDATE_IP, NO_PRIV_RANGE | NO_RES_RANGE) === false,
   * verified against PHP 8.4.8's exact ranges (see port notes):
   *   IPv4: 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 240/4.
   *   IPv6: ::/128, ::1/128, ::ffff:0:0/96 (v4-mapped), fc00::/7, fe80::/10.
   */
  private isPrivateIp(ip: string): boolean {
    if (net.isIPv4(ip)) {
      const o = ip.split('.').map((n) => parseInt(n, 10));
      const [a, b] = o;
      if (a === 0) return true;
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a >= 240) return true;
      return false;
    }
    if (net.isIPv6(ip)) {
      const bytes = this.ipv6ToBytes(ip);
      if (!bytes) return false;
      // ::/128 unspecified
      if (bytes.every((x) => x === 0)) return true;
      // ::1/128 loopback
      if (bytes.slice(0, 15).every((x) => x === 0) && bytes[15] === 1) return true;
      // ::ffff:0:0/96 IPv4-mapped
      if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return true;
      // fc00::/7 unique-local
      if ((bytes[0] & 0xfe) === 0xfc) return true;
      // fe80::/10 link-local
      if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
      return false;
    }
    return false;
  }

  /** Expand an IPv6 string (incl. "::" compression and embedded IPv4) to 16 bytes. */
  private ipv6ToBytes(ipRaw: string): number[] | null {
    let ip = ipRaw.split('%')[0]; // strip zone id
    let v4tail: number[] | null = null;
    if (ip.includes('.')) {
      const idx = ip.lastIndexOf(':');
      const v4 = ip.slice(idx + 1).split('.').map((n) => parseInt(n, 10));
      if (v4.length !== 4 || v4.some((n) => !(n >= 0 && n <= 255))) return null;
      v4tail = v4;
      ip = ip.slice(0, idx + 1); // keep the trailing ':'
    }
    const toBytes = (groups: string[]): number[] => {
      const out: number[] = [];
      for (const g of groups) {
        const v = parseInt(g, 16);
        if (Number.isNaN(v) || v < 0 || v > 0xffff) return [NaN];
        out.push((v >> 8) & 0xff, v & 0xff);
      }
      return out;
    };
    let head: string[];
    let tail: string[];
    if (ip.includes('::')) {
      const [h, t] = ip.split('::');
      head = h ? h.split(':').filter((x) => x !== '') : [];
      tail = t ? t.split(':').filter((x) => x !== '') : [];
    } else {
      head = ip.split(':').filter((x) => x !== '');
      tail = [];
    }
    const headB = toBytes(head);
    const tailB = toBytes(tail);
    if (headB.some(Number.isNaN) || tailB.some(Number.isNaN)) return null;
    const v4B = v4tail ?? [];
    const known = headB.length + tailB.length + v4B.length;
    let bytes: number[];
    if (ip.includes('::')) {
      const fill = 16 - known;
      if (fill < 0) return null;
      bytes = [...headB, ...new Array(fill).fill(0), ...tailB, ...v4B];
    } else {
      bytes = [...headB, ...tailB, ...v4B];
    }
    if (bytes.length !== 16) return null;
    return bytes;
  }

  /**
   * True when the request to this endpoint came from a loopback address. Mirrors PHP
   * callerIsLoopback (REMOTE_ADDR). Used to bypass the SSRF guard for same-machine callers.
   */
  private callerIsLoopback(ctx: Ctx): boolean {
    const remote = ctx.remote_addr ?? '';
    if (remote === '') return false;
    if (remote.startsWith('127.')) return true;
    if (remote === '::1') return true;
    if (remote.startsWith('::ffff:127.')) return true;
    return false;
  }

  /**
   * Decode the body via the Content-Type charset hint, falling back to a <meta charset> sniff in
   * the first 4 KB, then UTF-8. Mirrors PHP decodeBody (iconv → iconv-lite).
   */
  private decodeBody(body: Buffer, contentType: string): string {
    let charset: string | null = null;
    const m = contentType.match(/charset=([\w\-]+)/i);
    if (m) charset = m[1].toLowerCase();
    if (!charset) {
      const head = body.subarray(0, 4096).toString('latin1');
      const m2 = head.match(/<meta[^>]+charset=["']?([\w\-]+)/i);
      if (m2) charset = m2[1].toLowerCase();
    }
    if (!charset || charset === 'utf-8' || charset === 'utf8') {
      return body.toString('utf8');
    }
    try {
      if (iconv.encodingExists(charset)) {
        return iconv.decode(body, charset);
      }
      return body.toString('utf8');
    } catch {
      return body.toString('utf8');
    }
  }

  /** Low-level GET with TLS-off, redirect cap, decompression, byte cap and timeouts. */
  private httpGet(startUrl: string): Promise<{
    ok: boolean;
    error?: string;
    httpCode: number;
    contentType: string;
    finalUrl: string;
    body: Buffer;
    exceeded: boolean;
  }> {
    return new Promise((resolve) => {
      let redirectsLeft = UrlFetchController.MAX_REDIRECTS;
      let settled = false;
      const deadline = Date.now() + UrlFetchController.TIMEOUT_SECONDS * 1000;

      const done = (r: {
        ok: boolean;
        error?: string;
        httpCode: number;
        contentType: string;
        finalUrl: string;
        body: Buffer;
        exceeded: boolean;
      }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const request = (urlStr: string) => {
        let u: URL;
        try {
          u = new URL(urlStr);
        } catch {
          done({ ok: false, error: 'Invalid redirect URL', httpCode: 0, contentType: '', finalUrl: urlStr, body: Buffer.alloc(0), exceeded: false });
          return;
        }
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? https : http;
        const remaining = Math.max(1, deadline - Date.now());

        const req = lib.request(
          {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: (u.pathname || '/') + (u.search || ''),
            method: 'GET',
            headers: {
              'User-Agent': UrlFetchController.BROWSER_UA,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br',
            },
            ...(isHttps ? { rejectUnauthorized: false } : {}),
          },
          (res) => {
            const status = res.statusCode ?? 0;

            // Follow redirects (curl CURLOPT_FOLLOWLOCATION, capped at MAX_REDIRECTS).
            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
              redirectsLeft--;
              res.resume(); // drain
              let next: string;
              try {
                next = new URL(res.headers.location, urlStr).toString();
              } catch {
                done({ ok: false, error: 'Bad redirect Location', httpCode: status, contentType: '', finalUrl: urlStr, body: Buffer.alloc(0), exceeded: false });
                return;
              }
              request(next);
              return;
            }

            const contentType = String(res.headers['content-type'] ?? '');
            const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
            let stream: NodeJS.ReadableStream = res;
            if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

            const chunks: Buffer[] = [];
            let len = 0;
            let exceeded = false;

            stream.on('data', (c: Buffer) => {
              if (exceeded) return;
              len += c.length;
              chunks.push(c);
              if (len > UrlFetchController.MAX_BYTES) {
                exceeded = true;
                req.destroy();
                done({ ok: false, error: 'exceeded', httpCode: status, contentType, finalUrl: urlStr, body: Buffer.concat(chunks), exceeded: true });
              }
            });
            stream.on('end', () => {
              done({ ok: true, httpCode: status, contentType, finalUrl: urlStr, body: Buffer.concat(chunks), exceeded: false });
            });
            stream.on('error', (e: Error) => {
              done({ ok: false, error: e.message, httpCode: status, contentType, finalUrl: urlStr, body: Buffer.concat(chunks), exceeded });
            });
          }
        );

        req.on('error', (e: Error) => {
          done({ ok: false, error: e.message, httpCode: 0, contentType: '', finalUrl: urlStr, body: Buffer.alloc(0), exceeded: false });
        });

        // Connect timeout (until socket connects) then overall timeout.
        req.setTimeout(Math.min(remaining, UrlFetchController.CONNECT_TIMEOUT_SECONDS * 1000), () => {
          req.destroy(new Error('Connection timed out'));
        });
        req.once('socket', (socket) => {
          socket.once('connect', () => {
            const left = Math.max(1, deadline - Date.now());
            req.setTimeout(left, () => {
              req.destroy(new Error('Request timed out'));
            });
          });
        });

        req.end();
      };

      request(startUrl);
    });
  }
}
