<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument;

class PlaybookDocumentTest extends TestCase
{
    public function testFromArrayDefaultsPolicy(): void
    {
        $d = PlaybookDocument::fromArray([
            'title' => 'T', 'trigger' => ['kind' => 'request', 'description' => 'x'],
            'instructions' => 'Do #Foo.', 'tools_used' => ['Okta'],
            'actions_used' => ['#Foo'], 'bindings' => ['#Foo' => 'okta.foo'],
        ]);
        $this->assertSame('T', $d->title);
        $this->assertFalse($d->policy['writes_enabled']);
        $this->assertSame('handoff', $d->policy['on_unbound']);
        $this->assertSame('continue_then_handoff', $d->policy['on_failure']);
        $this->assertSame(['#Foo' => 'okta.foo'], $d->bindings);
    }

    public function testFromConsoleTextParsesSections(): void
    {
        $text = "Title: Okta Password / MFA Reset\n\n" .
            "Trigger: Requester reports being locked out.\n\n" .
            "Instructions: #Search Okta User by Email for the requester. #Resolve Request.\n\n" .
            "Tools used: Okta\n\n" .
            "Actions used: #Search Okta User by Email; #Resolve Request";
        $d = PlaybookDocument::fromConsoleText($text);
        $this->assertSame('Okta Password / MFA Reset', $d->title);
        $this->assertSame('request', $d->trigger['kind']);
        $this->assertStringContainsString('locked out', $d->trigger['description']);
        $this->assertStringContainsString('#Search Okta User by Email', $d->instructions);
        $this->assertSame(['Okta'], $d->toolsUsed);
        $this->assertSame(['#Search Okta User by Email', '#Resolve Request'], $d->actionsUsed);
        $this->assertSame([], $d->bindings);
    }

    public function testDomainField(): void
    {
        $d = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromArray([
            'title' => 'T', 'trigger' => ['kind' => 'request', 'description' => 'x'],
            'instructions' => '#Resolve Request.', 'domain' => 'an HR benefits desk',
        ]);
        $this->assertSame('an HR benefits desk', $d->domain);

        $text = "Title: T\n\nDomain: a finance operations team\n\nTrigger: y\n\nInstructions: #Resolve Request.";
        $t = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromConsoleText($text);
        $this->assertSame('a finance operations team', $t->domain);
        // Default: empty (interpreter substitutes a neutral phrase).
        $none = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromArray([
            'title' => 'T', 'trigger' => ['kind' => 'request', 'description' => 'x'],
            'instructions' => '#Resolve Request.']);
        $this->assertSame('', $none->domain);
    }

    public function testMissingTitleThrows(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        PlaybookDocument::fromArray(['instructions' => 'x']);
    }
}
