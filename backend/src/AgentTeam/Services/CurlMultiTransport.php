<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/** WatchTransport over one curl_multi: every active workflow's long-poll in this one process (spec 2026-10-14 event-worker §3). */
final class CurlMultiTransport implements WatchTransport
{
    /** The server answers by 150 s (wait_for_new's cap); a request still open at 180 s is a dead connection. */
    public const TIMEOUT_S = 180;

    private \CurlMultiHandle $multi;
    /** @var array<string, \CurlHandle> */
    private array $handles = [];

    public function __construct()
    {
        $this->multi = curl_multi_init();
    }

    public function start(string $key, string $url, array $headers, string $body): void
    {
        $this->cancel($key);
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => self::TIMEOUT_S,
            CURLOPT_CONNECTTIMEOUT => 15,
        ]);
        curl_multi_add_handle($this->multi, $ch);
        $this->handles[$key] = $ch;
    }

    public function cancel(string $key): void
    {
        if (isset($this->handles[$key])) {
            curl_multi_remove_handle($this->multi, $this->handles[$key]);
            curl_close($this->handles[$key]);
            unset($this->handles[$key]);
        }
    }

    public function done(): array
    {
        do {
            $status = curl_multi_exec($this->multi, $running);
        } while ($status === CURLM_CALL_MULTI_PERFORM);
        $out = [];
        while ($info = curl_multi_info_read($this->multi)) {
            $key = array_search($info['handle'], $this->handles, true);
            if ($key === false) {
                continue;
            }
            $ch = $this->handles[$key];
            $err = $info['result'] === CURLE_OK ? '' : (curl_error($ch) ?: 'curl error ' . $info['result']);
            $body = $err === '' ? curl_multi_getcontent($ch) : false;
            $out[$key] = [$body, (int) curl_getinfo($ch, CURLINFO_HTTP_CODE), $err];
            $this->cancel($key);
        }
        return $out;
    }

    /** Sleep until a request has news, at most $seconds. */
    public function wait(float $seconds): void
    {
        if (!$this->handles || curl_multi_select($this->multi, $seconds) === -1) {
            usleep((int) ($seconds * 1e6));
        }
    }
}
