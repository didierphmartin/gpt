<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Reads a Start document for the modular package, only from the requesting user's own
 * document storage (the place WorkflowController::uploadDocument writes it):
 * <ROOT_FOLDER>/<user folder>/<doc path>, through the user's universalFS adapter, else under
 * a local storage root with realpath containment -- GraphWorkflowRunner::readFileRaw's rules.
 *
 * The Start config is saved by the client, so its `path` is untrusted: an absolute path, a
 * `..` segment, a backslash or a document kept on the user's machine (storage "local") is
 * never read. `fullPath` is ignored: the location is rebuilt from the user's own folder.
 */
final class StartDocumentStore
{
    public const ROOT_FOLDER = 'synergyaichatroot';

    /** @var \Closure():?object|null */
    private ?\Closure $adapterFactory;
    private ?object $adapter = null;
    private bool $connected = false;

    /**
     * @param string $userFolder the user's storage folder (users.storage_folder, else "user_<id>")
     * @param \Closure|null $adapterFactory connects the user's universalFS adapter (may return null); called once, on first read
     * @param string|null $localRoot the local storage root (the controller's storage_path)
     */
    public function __construct(private string $userFolder, ?\Closure $adapterFactory = null, private ?string $localRoot = null)
    {
        $this->adapterFactory = $adapterFactory;
    }

    /** $path split into safe segments (no empty, ".", ".." segment, no "\", no NUL, not absolute), else null. */
    public static function safeSegments(string $path): ?array
    {
        if ($path === '' || str_starts_with($path, '/') || str_contains($path, '\\') || str_contains($path, "\0")) {
            return null;
        }
        $parts = explode('/', $path);
        foreach ($parts as $p) {
            if ($p === '' || $p === '.' || $p === '..') {
                return null;
            }
        }
        return $parts;
    }

    /** The document's bytes, or null when it is not in this user's storage (or cannot be read). */
    public function read(array $doc): ?string
    {
        if (($doc['storage'] ?? 'remote') === 'local') {
            return null;   // kept on the user's machine: the server never had it
        }
        $rel = self::safeSegments((string) ($doc['path'] ?? ''));
        $folder = self::safeSegments($this->userFolder);
        if ($rel === null || $folder === null) {
            return null;
        }
        $full = self::ROOT_FOLDER . '/' . implode('/', $folder) . '/' . implode('/', $rel);

        $adapter = $this->adapter();
        if ($adapter !== null) {
            try {
                $stream = $adapter->readStream('/' . $full);
                $bytes = stream_get_contents($stream);
                fclose($stream);
                if (is_string($bytes)) {
                    return $bytes;
                }
            } catch (\Throwable $e) {
                // fall through to the local root, as the runner does
            }
        }
        if ($this->localRoot === null) {
            return null;
        }
        $base = realpath($this->localRoot . '/' . self::ROOT_FOLDER . '/' . implode('/', $folder));
        $target = realpath($this->localRoot . '/' . $full);
        if ($base === false || $target === false || !str_starts_with($target, $base . DIRECTORY_SEPARATOR) || !is_file($target)) {
            return null;
        }
        $bytes = file_get_contents($target);
        return $bytes === false ? null : $bytes;
    }

    private function adapter(): ?object
    {
        if (!$this->connected) {
            $this->connected = true;
            try {
                $this->adapter = $this->adapterFactory !== null ? ($this->adapterFactory)() : null;
            } catch (\Throwable $e) {
                $this->adapter = null;
            }
        }
        return $this->adapter;
    }
}
