<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

/**
 * Carries ONE JSON-RPC message, unchanged, to an MCP server for the Test tab
 * and returns what came back. Transport errors are returned, never thrown.
 */
final class McpTestRelay
{
    private const EXPOSED = ['content-type', 'mcp-session-id', 'mcp-protocol-version'];

    /** @var callable */
    private $http;

    /** @param null|callable(string,array,string,int):array $http */
    public function __construct(?callable $http = null)
    {
        $this->http = $http ?? [self::class, 'curl'];
    }

    /**
     * The message is encoded as given: pass it as decoded objects (stdClass)
     * so empty JSON objects stay {} and do not turn into [].
     * An empty protocol version sends no mcp-protocol-version header.
     *
     * @param array<string,string> $headers
     * @param array<mixed>|object $message
     * @return array{url:string,status:int,headers:array,body:string,messages:array,duration_ms:int,error:?string}
     */
    public function relay(string $url, array $headers, array|object $message, ?string $sessionId, string $protocolVersion): array
    {
        $lines = [];
        $protocolVersion = (string) preg_replace('/[\r\n]/', '', $protocolVersion);
        if ($protocolVersion !== '') {
            $lines[] = 'mcp-protocol-version: ' . $protocolVersion;
        }
        $sessionId = $sessionId === null ? '' : (string) preg_replace('/[\r\n]/', '', $sessionId);
        if ($sessionId !== '') {
            $lines[] = 'mcp-session-id: ' . $sessionId;
        }
        foreach ($headers as $name => $value) {
            $lines[] = $name . ': ' . $value;
        }
        $t0 = microtime(true);
        try {
            $res = ($this->http)($url, $lines, json_encode($message), 20);
        } catch (\Throwable $e) {
            $res = ['status' => 0, 'headers' => [], 'body' => '', 'error' => $e->getMessage()];
        }
        $resHeaders = array_change_key_case((array) ($res['headers'] ?? []), CASE_LOWER);
        $body = (string) ($res['body'] ?? '');
        return [
            'url' => $url,
            'status' => (int) ($res['status'] ?? 0),
            'headers' => self::exposedHeaders($resHeaders),
            'body' => $body,
            'messages' => self::parseMessages($resHeaders['content-type'] ?? '', $body),
            'duration_ms' => (int) round((microtime(true) - $t0) * 1000),
            'error' => $res['error'] ?? null,
        ];
    }

    /** @return list<\stdClass> */
    public static function parseMessages(string $contentType, string $body): array
    {
        $out = [];
        if (stripos($contentType, 'text/event-stream') !== false) {
            $events = preg_split('/\n\n+/', str_replace(["\r\n", "\r"], "\n", $body)) ?: [];
            foreach ($events as $event) {
                $data = [];
                foreach (explode("\n", $event) as $line) {
                    if (str_starts_with($line, 'data:')) {
                        $data[] = ltrim(substr($line, 5), ' ');
                    }
                }
                if ($data === []) {
                    continue;
                }
                array_push($out, ...self::messagesOf(implode("\n", $data)));
            }
            return $out;
        }
        return self::messagesOf($body);
    }

    /**
     * One JSON text → its JSON-RPC message objects (a batch array gives several). Decoded as objects, never
     * assoc arrays: an assoc decode turns the server's {} into [] and the validator would blame the server.
     * @return list<\stdClass>
     */
    private static function messagesOf(string $json): array
    {
        $decoded = json_decode($json);
        if ($decoded instanceof \stdClass) {
            return [$decoded];
        }
        return is_array($decoded) ? array_values(array_filter($decoded, fn ($m) => $m instanceof \stdClass)) : [];
    }

    /** @return array<string,string> */
    public static function exposedHeaders(array $headers): array
    {
        $headers = array_change_key_case($headers, CASE_LOWER);
        $out = [];
        foreach (self::EXPOSED as $name) {
            if (isset($headers[$name])) {
                $out[$name] = (string) $headers[$name];
            }
        }
        return $out;
    }

    /** @return array{status:int,headers:array<string,string>,body:string,error:?string} */
    public static function curl(string $url, array $headerLines, string $body, int $timeoutS): array
    {
        $resHeaders = [];
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => array_merge(
                ['Accept: application/json, text/event-stream', 'Content-Type: application/json'],
                $headerLines
            ),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT => $timeoutS,
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$resHeaders): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $resHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);
        $raw = curl_exec($ch);
        $error = $raw === false ? curl_error($ch) : null;
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return ['status' => $status, 'headers' => $resHeaders, 'body' => $raw === false ? '' : (string) $raw, 'error' => $error];
    }
}
