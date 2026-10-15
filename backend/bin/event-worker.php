<?php
/**
 * The event worker (spec 2026-10-14 event-worker): runs each user's active workflow -- on its schedule, or on its
 * Start option's event -- until SIGTERM / SIGINT. Supervised by launchd (bin/com.synergyai.event-worker.plist).
 *   php backend/bin/event-worker.php
 */
declare(strict_types=1);

use AgentTeam\Services\ActiveWorkflowService;
use AgentTeam\Services\CurlMultiTransport;
use AgentTeam\Services\EventWorker;
use AgentTeam\Services\ProcRunSpawner;
use AgentTeam\Services\WatchCall;

require_once __DIR__ . '/../vendor/autoload.php';

$log = static fn(string $line) => print('[' . date('Y-m-d H:i:s') . "] {$line}\n");
$config = require __DIR__ . '/../config/ai_config.php';
$connect = static function () use ($config): PDO {
    $db = $config['contexts_database'] ?? $config['database'];
    return new PDO("mysql:host={$db['host']};dbname={$db['database']};charset={$db['charset']}", $db['username'], $db['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false, PDO::ATTR_TIMEOUT => 5]);
};

$stop = false;
pcntl_async_signals(true);
pcntl_signal(SIGTERM, function () use (&$stop) { $stop = true; });
pcntl_signal(SIGINT, function () use (&$stop) { $stop = true; });

$transport = new CurlMultiTransport();
$runs = new ProcRunSpawner(PHP_BINARY, dirname(__DIR__), 1800, $log);
$worker = null;
$pdo = null;
$lastPing = 0.0;
$log('event worker started (pid ' . getmypid() . ')');
while (!$stop) {
    try {
        if ($worker === null) {
            $pdo = $connect();
            $worker = new EventWorker(new ActiveWorkflowService($pdo),
                fn(int $user, string $name) => WatchCall::server($pdo, $user, $name),
                $transport, $runs, fn() => microtime(true));
        }
        // EventWorker::step() swallows its own errors, so a dead connection is found here, every 5 s.
        if (microtime(true) - $lastPing >= 5.0) {
            $pdo->query('SELECT 1');
            $lastPing = microtime(true);
        }
        $worker->step();
        $transport->wait(1.0);
    } catch (\PDOException $e) {
        // The database went away: keep the waits, reconnect in 10 s (spec §4).
        $log('database: ' . $e->getMessage() . ' -- retrying in 10 s');
        $worker = null;
        $lastPing = 0.0;
        sleep(10);
    } catch (\Throwable $e) {
        // A bug must not kill the process: log it, carry on after 1 s.
        $log(get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
        sleep(1);
    }
}
$log('stopping: letting runs finish (≤ 30 s)');
$worker?->stop();
$runs->stopAll(30);
$log('event worker stopped');
exit(0);
