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

    /** Install can run for minutes (dependency downloads); everything else is quick. */
    private static function curl(string $method, string $url, array $headers, ?string $body): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => str_ends_with($url, '/install') ? 900 : 15,
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
