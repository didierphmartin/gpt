<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\{PlaybookAnalyzer, PlaybookDocument};

class PlaybookAnalyzerTest extends TestCase
{
    private function doc(array $over = []): PlaybookDocument
    {
        return PlaybookDocument::fromArray(array_merge([
            'title' => 'MFA', 'trigger' => ['kind' => 'request', 'description' => 'locked out'],
            'instructions' => "#Search Okta User by Email first. Medium risk: #Request Approval from manager. " .
                "High: #Prompt for Handoff to security. Then #Reset Password (Okta). " .
                "#Reset User Factors (Custom) if lost device. #Leave Internal Note. #Resolve Request.",
            'tools_used' => ['Okta'],
            'actions_used' => ['#Search Okta User by Email', '#Request Approval', '#Prompt for Handoff',
                '#Reset Password (Okta)', '#Reset User Factors (Custom)', '#Leave Internal Note', '#Resolve Request'],
            'bindings' => ['#Search Okta User by Email' => 'okta.search_users',
                '#Reset Password (Okta)' => 'okta.reset_password',
                '#Reset User Factors (Custom)' => null],
        ], $over));
    }

    public function testClassification(): void
    {
        $r = (new PlaybookAnalyzer())->analyze($this->doc(), ['okta.search_users', 'okta.reset_password']);
        $byName = array_column($r['actions'], null, 'name');
        $this->assertSame('bound', $byName['#Search Okta User by Email']['kind']);
        $this->assertSame('okta.search_users', $byName['#Search Okta User by Email']['target']);
        $this->assertSame('native', $byName['#Request Approval']['kind']);
        $this->assertSame('native', $byName['#Resolve Request']['kind']);
        $this->assertSame('unbound', $byName['#Reset User Factors (Custom)']['kind']);
        $this->assertContains('approval', $r['gates']);
        $this->assertContains('handoff', $r['gates']);
        $this->assertSame([], $r['errors']);
        $this->assertNotEmpty($r['warnings']); // the unbound action
    }

    public function testDanglingBindingIsError(): void
    {
        $r = (new PlaybookAnalyzer())->analyze($this->doc(), ['okta.search_users']); // reset_password missing
        $this->assertNotEmpty($r['errors']);
        $this->assertStringContainsString('#Reset Password (Okta)', $r['errors'][0]);
    }

    public function testChecklistPreservesProseOrder(): void
    {
        $r = (new PlaybookAnalyzer())->analyze($this->doc(), ['okta.search_users', 'okta.reset_password']);
        $this->assertSame('#Search Okta User by Email', $r['checklist'][0]);
        $this->assertSame('#Resolve Request', end($r['checklist']));
    }

    public function testChecklistOrderHandlesOverlappingActionNames(): void
    {
        // "#Reset User Factor" is a literal prefix of "#Reset User Factors
        // (Custom)". The long name's real occurrence comes first in the prose;
        // the short name's real (standalone) occurrence comes later. Without
        // masking the long name's match first, a naive stripos() for the short
        // name would find it embedded inside the long name's earlier occurrence
        // and misreport it as coming first.
        $doc = PlaybookDocument::fromArray([
            'title' => 'Overlap',
            'trigger' => ['kind' => 'request', 'description' => 'd'],
            'instructions' => '#Reset User Factors (Custom) if the device is lost. '
                . 'Separately, later, #Reset User Factor for legacy systems. #Resolve Request.',
            'actions_used' => ['#Reset User Factor', '#Reset User Factors (Custom)', '#Resolve Request'],
            'bindings' => ['#Reset User Factor' => null, '#Reset User Factors (Custom)' => null],
        ]);

        $r = (new PlaybookAnalyzer())->analyze($doc, []);

        $this->assertSame(
            ['#Reset User Factors (Custom)', '#Reset User Factor', '#Resolve Request'],
            $r['checklist']
        );
    }

    public function testAutoBindingFromConsoleTextWithNoBindings(): void
    {
        // The markdown/Console text is the source format: with no bindings
        // block, the analyzer must translate #Actions to connected tools
        // by name-matching (explicit null still means deliberately unbound).
        $doc = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromArray([
            'title' => 'MFA', 'trigger' => ['kind' => 'request', 'description' => 'locked out'],
            'instructions' => "#Search Okta User by Email first. #Search Okta System Log Custom next. " .
                "#List User Factors. Then #Reset Password (Okta) or #Reset User Factor. " .
                "#Reset User Factors (Custom) if lost device. #Leave Internal Note. #Resolve Request.",
            'tools_used' => ['Okta'],
            'actions_used' => ['#Search Okta User by Email', '#Search Okta System Log Custom',
                '#List User Factors', '#Reset Password (Okta)', '#Reset User Factor',
                '#Reset User Factors (Custom)', '#Leave Internal Note', '#Resolve Request'],
            // no bindings at all — plain pasted text
        ]);
        $tools = ['okta.search_users', 'okta.search_system_log', 'okta.list_user_factors',
            'okta.verify_security_answers', 'okta.reset_password', 'okta.reset_factor', 'okta.unlock_user'];
        $r = (new PlaybookAnalyzer())->analyze($doc, $tools);
        $byName = array_column($r['actions'], null, 'name');
        $this->assertSame('bound', $byName['#Search Okta User by Email']['kind']);
        $this->assertSame('okta.search_users', $byName['#Search Okta User by Email']['target']);
        $this->assertTrue($byName['#Search Okta User by Email']['auto']);
        $this->assertSame('okta.search_system_log', $byName['#Search Okta System Log Custom']['target']);
        $this->assertSame('okta.list_user_factors', $byName['#List User Factors']['target']);
        $this->assertSame('okta.reset_password', $byName['#Reset Password (Okta)']['target']);
        $this->assertSame('okta.reset_factor', $byName['#Reset User Factor']['target']);
        $this->assertSame('okta.reset_factor', $byName['#Reset User Factors (Custom)']['target']);
        $this->assertSame('native', $byName['#Leave Internal Note']['kind']);
        $this->assertSame([], $r['errors']);
        // Auto-bindings are surfaced transparently.
        $this->assertNotEmpty(array_filter($r['warnings'], fn($w) => str_contains($w, 'Auto-bound')));
    }

    public function testExplicitNullBindingIsNotAutoBound(): void
    {
        $doc = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromArray([
            'title' => 'T', 'trigger' => ['kind' => 'request', 'description' => 'd'],
            'instructions' => '#Reset User Factors (Custom) then #Resolve Request.',
            'actions_used' => ['#Reset User Factors (Custom)', '#Resolve Request'],
            'bindings' => ['#Reset User Factors (Custom)' => null],
        ]);
        $r = (new PlaybookAnalyzer())->analyze($doc, ['okta.reset_factor']);
        $byName = array_column($r['actions'], null, 'name');
        $this->assertSame('unbound', $byName['#Reset User Factors (Custom)']['kind']);
    }

    public function testAmbiguousNameStaysUnbound(): void
    {
        $doc = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromArray([
            'title' => 'T', 'trigger' => ['kind' => 'request', 'description' => 'd'],
            'instructions' => '#Do Thing then #Resolve Request.',
            'actions_used' => ['#Do Thing', '#Resolve Request'],
        ]);
        // No token overlap at all -> no auto-bind, stays a warning.
        $r = (new PlaybookAnalyzer())->analyze($doc, ['okta.reset_password', 'okta.reset_factor']);
        $byName = array_column($r['actions'], null, 'name');
        $this->assertSame('unbound', $byName['#Do Thing']['kind']);
    }

    public function testAgentBinding(): void
    {
        $doc = $this->doc(['bindings' => ['#Search Okta User by Email' => 'agent.researcher',
            '#Reset Password (Okta)' => 'okta.reset_password', '#Reset User Factors (Custom)' => null]]);
        $ok = (new PlaybookAnalyzer())->analyze($doc, ['okta.reset_password'], ['researcher']);
        $this->assertSame('bound', array_column($ok['actions'], null, 'name')['#Search Okta User by Email']['kind']);
        $bad = (new PlaybookAnalyzer())->analyze($doc, ['okta.reset_password'], []);
        $this->assertNotEmpty($bad['errors']);
    }
}
