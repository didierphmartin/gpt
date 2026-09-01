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
