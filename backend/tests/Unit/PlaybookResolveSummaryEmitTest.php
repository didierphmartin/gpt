<?php
declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\PlaybookEmit;
use PHPUnit\Framework\TestCase;

/**
 * Compiled playbook runtimes end a run's answer the way the server interpreter does: the
 * resolve_request summary is the result (the turn's own text only when there is none).
 */
final class PlaybookResolveSummaryEmitTest extends TestCase
{
    public function testPlaybookEmitRuntimeUsesTheResolveSummary(): void
    {
        $code = PlaybookEmit::supportBlock(true) . "\n" . PlaybookEmit::runtimeBlock();
        $this->assertStringContainsString('run.summary = str(a.get("summary") or "").strip()', $code);
        $this->assertStringContainsString('render_playbook_transcript(pb["title"], run.events, run.summary or text, run.status)', $code);
    }

    public function testLangGraphRuntimeUsesTheResolveSummary(): void
    {
        $src = file_get_contents(__DIR__ . '/../../src/AgentTeam/Services/LangGraphRuntime.php');
        $this->assertStringContainsString('run.summary = str(a.get("summary") or "").strip()', $src);
        $this->assertStringContainsString('run.transcript(pb["title"], run.summary or text)', $src);
        $this->assertStringContainsString('self.summary = ""', $src);
    }
}
