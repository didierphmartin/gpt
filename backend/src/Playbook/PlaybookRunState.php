<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook;

final class PlaybookRunState
{
    private const REDACTED = '«redacted»';

    public function __construct(
        private readonly \PDO $pdo,
        private readonly PlaybookTranscript $transcript,
    ) {}

    public function createRun(int $userId, PlaybookDocument $doc, array $requester, array $variables): int
    {
        $now = date('Y-m-d H:i:s');
        $stmt = $this->pdo->prepare(
            'INSERT INTO playbook_runs
                (user_id, playbook_title, document, status, requester, variables, pending_gate, current_leg, coverage, created_at, updated_at, resolved_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, NULL)'
        );
        $stmt->execute([
            $userId,
            $doc->title,
            json_encode($doc->toArray(), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'running',
            json_encode($requester, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            json_encode($variables, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            $now,
            $now,
        ]);
        return (int)$this->pdo->lastInsertId();
    }

    public function setStatus(int $runId, string $status): void
    {
        $stmt = $this->pdo->prepare('UPDATE playbook_runs SET status = ?, updated_at = ? WHERE id = ?');
        $stmt->execute([$status, date('Y-m-d H:i:s'), $runId]);
    }

    public function addMessage(int $runId, string $direction, ?string $audience, string $text, bool $sensitive = false): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO playbook_run_messages (run_id, direction, audience, text, `sensitive`, created_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $runId,
            $direction,
            $audience,
            $sensitive ? self::REDACTED : $text,
            $sensitive ? 1 : 0,
            date('Y-m-d H:i:s'),
        ]);
    }

    public function addNote(int $runId, string $text, string $author = 'agent'): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO playbook_run_notes (run_id, author, text, created_at) VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([$runId, $author, $text, date('Y-m-d H:i:s')]);
    }

    public function ledgerAppend(
        int $runId,
        int $leg,
        string $actionName,
        string $tool,
        array $args,
        string $outcome,
        ?string $summary,
        bool $sensitive = false
    ): void {
        $seqStmt = $this->pdo->prepare(
            'SELECT COALESCE(MAX(seq), 0) FROM playbook_run_ledger WHERE run_id = ?'
        );
        $seqStmt->execute([$runId]);
        $seq = 1 + (int)$seqStmt->fetchColumn();

        $argsJson = $sensitive ? json_encode(self::REDACTED, JSON_UNESCAPED_UNICODE) : $this->canon($args);
        $resultSummary = $sensitive ? self::REDACTED : $summary;

        $stmt = $this->pdo->prepare(
            'INSERT INTO playbook_run_ledger
                (run_id, leg, seq, action_name, tool, args, outcome, result_summary, returned_ids, `sensitive`, duration_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)'
        );
        $stmt->execute([
            $runId,
            $leg,
            $seq,
            $actionName,
            $tool,
            $argsJson,
            $outcome,
            $resultSummary,
            $sensitive ? 1 : 0,
            date('Y-m-d H:i:s'),
        ]);
    }

    public function ledgerFindOk(int $runId, string $tool, array $args): ?array
    {
        $stmt = $this->pdo->prepare(
            "SELECT * FROM playbook_run_ledger WHERE run_id = ? AND tool = ? AND outcome = 'ok' AND args = ?
             ORDER BY seq DESC"
        );
        $stmt->execute([$runId, $tool, $this->canon($args)]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    public function gateOpen(int $runId, int $leg, string $kind, array $args, string $askedOf): int
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO playbook_run_gates (run_id, leg, kind, args, asked_of, opened_at, closed_at, decision, actor)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)'
        );
        $stmt->execute([
            $runId,
            $leg,
            $kind,
            json_encode($args, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            $askedOf,
            date('Y-m-d H:i:s'),
        ]);
        return (int)$this->pdo->lastInsertId();
    }

    public function gateClose(int $gateId, array $decision, string $actor): void
    {
        $stmt = $this->pdo->prepare(
            'UPDATE playbook_run_gates SET closed_at = ?, decision = ?, actor = ? WHERE id = ?'
        );
        $stmt->execute([
            date('Y-m-d H:i:s'),
            json_encode($decision, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            $actor,
            $gateId,
        ]);
    }

    public function getRun(int $runId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM playbook_runs WHERE id = ?');
        $stmt->execute([$runId]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $row === false ? [] : $row;
    }

    public function ledgerAll(int $runId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM playbook_run_ledger WHERE run_id = ? ORDER BY seq ASC');
        $stmt->execute([$runId]);
        return $stmt->fetchAll(\PDO::FETCH_ASSOC) ?: [];
    }

    /** Recursively ksort then json_encode so identical args match regardless of key order. */
    private function canon(array $a): string
    {
        return json_encode($this->ksortRecursive($a), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    private function ksortRecursive(array $a): array
    {
        foreach ($a as $k => $v) {
            if (is_array($v)) {
                $a[$k] = $this->ksortRecursive($v);
            }
        }
        ksort($a);
        return $a;
    }
}
