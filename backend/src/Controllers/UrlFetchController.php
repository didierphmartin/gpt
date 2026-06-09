<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;

/**
 * URL Fetch Controller
 *
 * Server-side URL fetcher for skills running in Pyodide. Browser-Python
 * cannot perform cross-origin XHR for sites without CORS headers (which is
 * virtually every production site), so the frontend's skill dispatcher
 * intercepts URL arguments and routes them through this endpoint instead.
 * The fetched HTML is then written into Pyodide's virtual FS as a file
 * the skill script reads normally.
 *
 * Security:
 *   - Blocks non-http(s) schemes.
 *   - Blocks loopback / private / link-local IPs to prevent SSRF against
 *     internal infrastructure.
 *   - Caps response body at MAX_BYTES so a malicious target can't fill memory.
 *   - 30s timeout — long enough for slow blogs, short enough to avoid hangs.
 *
 * Returns gzip/deflate-decompressed HTML decoded as a UTF-8 string. The
 * caller doesn't need to handle Content-Encoding.
 */
class UrlFetchController
{
    private const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
    private const TIMEOUT_SECONDS = 30;
    private const CONNECT_TIMEOUT_SECONDS = 10;
    private const MAX_REDIRECTS = 5;
    private const BROWSER_UA =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' .
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    public function __construct(PDO $_db, array $_config)
    {
        // No DB or config needed — pure HTTP fetcher.
    }

    /**
     * POST /api/v1/fetch-url
     *
     * Body: { "url": "https://example.com/article" }
     *   - Bare domains (e.g. "example.com") are auto-prepended with "https://".
     *
     * Returns:
     *   { success: true,  url, final_url, status, content_type, html, bytes }
     *   { success: false, error, status_code }
     */
    public function fetch(array $request): array
    {
        $body = $request['body'] ?? [];
        $url = isset($body['url']) ? trim((string)$body['url']) : '';

        if ($url === '') {
            return ['success' => false, 'error' => 'Missing required field: url', 'status_code' => 400];
        }

        // Auto-prepend https:// for bare domains.
        if (!preg_match('#^https?://#i', $url)) {
            if ($this->looksLikeBareDomain($url)) {
                $url = 'https://' . $url;
            } else {
                return ['success' => false, 'error' => 'Input is not a URL or recognizable domain', 'status_code' => 400];
            }
        }

        $parts = parse_url($url);
        if (!$parts || empty($parts['host'])) {
            return ['success' => false, 'error' => 'Invalid URL', 'status_code' => 400];
        }

        // SSRF guard — block loopback, private, link-local, multicast.
        //
        // Exception: if the HTTP request to THIS endpoint came from a loopback
        // address (i.e. the caller is on the same machine as this server, as
        // happens in local XAMPP dev), bypass the guard. The SSRF threat
        // model is "attacker on the public internet probes the server's
        // internal network" — that threat doesn't exist when the attacker
        // would already have full local-machine access. REMOTE_ADDR is set
        // by the web server from the TCP socket and cannot be spoofed.
        if (!$this->callerIsLoopback() && $this->isPrivateHost($parts['host'])) {
            return [
                'success' => false,
                'error' => 'Refusing to fetch from a private/internal address',
                'status_code' => 403,
            ];
        }

        $ch = curl_init();
        $bodyBuffer = '';
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => self::MAX_REDIRECTS,
            CURLOPT_TIMEOUT => self::TIMEOUT_SECONDS,
            CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT_SECONDS,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_ENCODING => '', // tell curl to advertise + auto-decompress gzip/deflate
            CURLOPT_USERAGENT => self::BROWSER_UA,
            CURLOPT_HTTPHEADER => [
                'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language: en-US,en;q=0.9',
            ],
            // Stream into our buffer with a size cap. CURLOPT_WRITEFUNCTION
            // returning a short count aborts the transfer, which is exactly
            // what we want when the response exceeds MAX_BYTES.
            CURLOPT_WRITEFUNCTION => function ($_ch, $chunk) use (&$bodyBuffer) {
                $bodyBuffer .= $chunk;
                if (strlen($bodyBuffer) > self::MAX_BYTES) {
                    return 0; // signal abort
                }
                return strlen($chunk);
            },
        ]);

        $ok = curl_exec($ch);
        $err = curl_error($ch);
        $errno = curl_errno($ch);
        $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $contentType = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $finalUrl = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        curl_close($ch);

        if ($ok === false && strlen($bodyBuffer) <= self::MAX_BYTES) {
            return [
                'success' => false,
                'error' => "Fetch failed (curl errno {$errno}): {$err}",
                'status_code' => 502,
            ];
        }
        if (strlen($bodyBuffer) > self::MAX_BYTES) {
            return [
                'success' => false,
                'error' => 'Response exceeded ' . self::MAX_BYTES . ' bytes',
                'status_code' => 502,
            ];
        }
        if ($httpCode < 200 || $httpCode >= 400) {
            // Upstream returned a non-2xx (404, 503, etc.). This is the
            // target's own response — not a gateway failure on our end — so
            // return our own 200 OK with success:false and the upstream
            // status in `data.upstream_status`. The previous 502 mapping
            // caused noisy "Bad Gateway" entries in the browser console for
            // every /robots.txt or /llms.txt 404, which skill scripts
            // already handle gracefully via the `success` flag.
            return [
                'success' => false,
                'error' => "Upstream returned HTTP {$httpCode}",
                'data' => [
                    'upstream_status' => $httpCode,
                    'final_url' => $finalUrl,
                ],
            ];
        }

        $html = $this->decodeBody($bodyBuffer, $contentType);

        return [
            'success' => true,
            'data' => [
                'url' => $url,
                'final_url' => $finalUrl,
                'status' => $httpCode,
                'content_type' => $contentType,
                'bytes' => strlen($bodyBuffer),
                'html' => $html,
            ],
        ];
    }

    /**
     * True for strings like "example.com" or "www.foo.org/path" — at least
     * one dot, alphanumeric/dash/dot only, TLD ≥ 2 chars. Conservative on
     * purpose to avoid false positives on file paths or random tokens.
     */
    private function looksLikeBareDomain(string $s): bool
    {
        if (str_contains($s, '@') || str_starts_with($s, '/') || str_starts_with($s, './') || str_starts_with($s, '../')) {
            return false;
        }
        $host = explode('/', $s, 2)[0];
        $parts = explode('.', $host);
        if (count($parts) < 2 || strlen(end($parts)) < 2) {
            return false;
        }
        return (bool) preg_match('/^[a-zA-Z0-9.\-]+$/', $host);
    }

    /**
     * Block loopback, private (RFC1918), link-local, and multicast addresses.
     * Resolves the hostname and checks every returned A/AAAA — a single
     * private address among multiple is enough to refuse.
     */
    private function isPrivateHost(string $host): bool
    {
        // Direct IP literals
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            return $this->isPrivateIp($host);
        }
        // Hostname → resolve. Use both v4 and v6.
        $ips = [];
        $v4 = @gethostbynamel($host);
        if (is_array($v4)) {
            $ips = array_merge($ips, $v4);
        }
        // dns_get_record for AAAA
        $records = @dns_get_record($host, DNS_AAAA);
        if (is_array($records)) {
            foreach ($records as $r) {
                if (!empty($r['ipv6'])) {
                    $ips[] = $r['ipv6'];
                }
            }
        }
        if (empty($ips)) {
            // Couldn't resolve — let curl handle it. Don't block on DNS failure.
            return false;
        }
        foreach ($ips as $ip) {
            if ($this->isPrivateIp($ip)) {
                return true;
            }
        }
        return false;
    }

    private function isPrivateIp(string $ip): bool
    {
        $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
        // FILTER_VALIDATE_IP returns false when the address is in the excluded
        // ranges — i.e. it's private/reserved. Inverting gives the "is private" answer.
        return filter_var($ip, FILTER_VALIDATE_IP, $flags) === false;
    }

    /**
     * True when the HTTP request to this endpoint came from a loopback
     * address. Used to bypass the SSRF guard for same-machine callers
     * (local XAMPP dev). REMOTE_ADDR is set by the web server from the
     * actual TCP connection and cannot be spoofed by the client.
     */
    private function callerIsLoopback(): bool
    {
        $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        if ($remote === '') {
            return false;
        }
        // IPv4 loopback (127.0.0.0/8) and IPv6 loopback (::1).
        if (str_starts_with($remote, '127.')) return true;
        if ($remote === '::1') return true;
        // Some setups encode IPv6-mapped IPv4 as ::ffff:127.x.x.x
        if (str_starts_with($remote, '::ffff:127.')) return true;
        return false;
    }

    /**
     * Decode the response body using charset hint from Content-Type, falling
     * back to <meta charset> sniff in the first 4 KB, then UTF-8.
     */
    private function decodeBody(string $body, string $contentType): string
    {
        $charset = null;
        if (preg_match('/charset=([\w\-]+)/i', $contentType, $m)) {
            $charset = strtolower($m[1]);
        }
        if (!$charset) {
            $head = substr($body, 0, 4096);
            if (preg_match('/<meta[^>]+charset=["\']?([\w\-]+)/i', $head, $m)) {
                $charset = strtolower($m[1]);
            }
        }
        if (!$charset || $charset === 'utf-8' || $charset === 'utf8') {
            return $body;
        }
        $converted = @iconv($charset, 'UTF-8//IGNORE', $body);
        return $converted === false ? $body : $converted;
    }
}
