<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Services;

/**
 * Talks to the Docker app's server supervisor (docker/mcps) with the shared Bearer token.
 * Bodies carry server secrets, so nothing here logs a request or a response.
 */
final class McpHostClient
{
    /** @var callable(string, string, array<int,string>, ?string): array{0:int,1:string} */
    private $transport;

    /** @param ?callable $transport (method, url, headers, body) => [status, body text]; status 0 = unreachable */
    public function __construct(private readonly string $baseUrl, private readonly string $token, ?callable $transport = null)
    {
        $this->transport = $transport ?? [self::class, 'curl'];
    }

    /** @return array{status:int, body:array} */
    public function request(string $method, string $path, ?array $body = null): array
    {
        $headers = ['Authorization: Bearer ' . $this->token, 'Accept: application/json'];
        $payload = null;
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
            $payload = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        try {
            [$status, $text] = ($this->transport)($method, rtrim($this->baseUrl, '/') . $path, $headers, $payload);
        } catch (\Throwable) {
            return ['status' => 503, 'body' => ['error' => 'unreachable']];
        }
        if ($status < 100) {
            return ['status' => 503, 'body' => ['error' => 'unreachable']];
        }
        $decoded = json_decode((string) $text, true);
        return ['status' => $status, 'body' => is_array($decoded) ? $decoded : []];
    }

    /**
     * Seconds to wait for the supervisor: install can run for minutes (dependency downloads); a call that
     * stops a server (restart, enabled, delete, settings save) waits out its 10 s stop grace; the rest is quick.
     */
    public static function timeoutFor(string $method, string $url): int
    {
        $path = (string) parse_url($url, PHP_URL_PATH);
        if (str_ends_with($path, '/install')) {
            return 900;
        }
        if ($method === 'DELETE' || str_ends_with($path, '/restart') || str_ends_with($path, '/enabled')
            || ($method === 'PUT' && str_ends_with($path, '/settings'))) {
            return 30;
        }
        return 15;
    }

    private static function curl(string $method, string $url, array $headers, ?string $body): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => self::timeoutFor($method, $url),
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $text = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return [$text === false ? 0 : $status, $text === false ? '' : (string) $text];
    }
}
