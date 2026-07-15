<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\GenesisProposer;

class GenesisProposerTest extends TestCase
{
    public function testParseProposalExtractsFirstJsonObject(): void
    {
        $text = "Here is my proposal:\n{\"skill_name\":\"Competitor Price Scan!\"," .
            "\"description\":\"WHEN asked to scan competitor prices DO fetch, extract, chart\"," .
            "\"eval_queries\":[{\"query\":\"scan competitor prices\",\"should_trigger\":true}]," .
            "\"merge_target\":null,\"rationale\":\"seen 3 times\"}\nHope this helps.";
        $p = GenesisProposer::parseProposal($text);
        $this->assertNotNull($p);
        // name is sanitized to kebab-case
        $this->assertSame('competitor-price-scan', $p['skill_name']);
        $this->assertCount(1, $p['eval_queries']);
        $this->assertTrue($p['eval_queries'][0]['should_trigger']);
        $this->assertNull($p['merge_target']);
    }

    public function testParseProposalRejectsMissingFields(): void
    {
        $this->assertNull(GenesisProposer::parseProposal('{"description":"no name"}'));
        $this->assertNull(GenesisProposer::parseProposal('not json at all'));
    }

    public function testParseProposalDropsMalformedEvalQueries(): void
    {
        $text = '{"skill_name":"x-y","description":"d","eval_queries":' .
            '[{"query":"good","should_trigger":true},{"bad":"row"},{"query":"neg","should_trigger":false}]}';
        $p = GenesisProposer::parseProposal($text);
        $this->assertCount(2, $p['eval_queries']);
    }

    public function testParseProposalAcceptsMergeShape(): void
    {
        $text = '{"skill_name":null,"merge_target":"medium-format",' .
            '"description":"WHEN asked to convert to Medium DO transform",' .
            '"eval_queries":[{"query":"convert to medium","should_trigger":true}]}';
        $p = GenesisProposer::parseProposal($text);
        $this->assertNotNull($p);
        $this->assertTrue($p['is_merge']);
        $this->assertSame('medium-format', $p['skill_name']);
        $this->assertSame('medium-format', $p['merge_target']);
    }

    public function testParseProposalStillRejectsWhenBothNamesEmpty(): void
    {
        $this->assertNull(GenesisProposer::parseProposal(
            '{"skill_name":null,"merge_target":null,"description":"d"}'
        ));
    }

    public function testConversationPromptContainsTranscriptAndCatalog(): void
    {
        $prompt = GenesisProposer::buildConversationPrompt(
            [['role' => 'user', 'content' => 'make me a newsletter about AI'],
             ['role' => 'assistant', 'content' => 'Here is your newsletter…']],
            [['name' => 'composed-newsletter', 'description' => 'WHEN asked for a newsletter…']]
        );
        $this->assertStringContainsString('make me a newsletter about AI', $prompt);
        $this->assertStringContainsString('composed-newsletter', $prompt);
        $this->assertStringContainsString('merge_target', $prompt);
    }

    public function testWorkflowPromptContainsRunDiffMaterial(): void
    {
        $prompt = GenesisProposer::buildWorkflowPrompt(
            ['id' => 7, 'name' => 'Newsletter Pipeline', 'description' => 'crypto+pubmed → publisher'],
            [['input_variables' => ['topic' => 'crypto']], ['input_variables' => ['topic' => 'biomed']]],
            []
        );
        $this->assertStringContainsString('Newsletter Pipeline', $prompt);
        $this->assertStringContainsString('"topic": "crypto"', $prompt);
        $this->assertStringContainsString('parameter_schema', $prompt);
    }

    public function testWorkflowPromptContainsStructure(): void
    {
        $prompt = GenesisProposer::buildWorkflowPrompt(
            [
                'id' => 7,
                'name' => 'Newsletter Pipeline',
                'description' => 'crypto+pubmed → publisher',
                'nodes' => [
                    ['type' => 'agent', 'name' => 'Researcher', 'instructions' => 'Research crypto news daily'],
                ],
            ],
            [['input_variables' => ['topic' => 'crypto']]],
            []
        );
        $this->assertStringContainsString('STRUCTURE', $prompt);
        $this->assertStringContainsString('Researcher', $prompt);
        $this->assertStringContainsString('Research crypto news daily', $prompt);
    }

    /** Legacy workflows (pre-editor, or rows never migrated to workflow_nodes) still render via steps. */
    public function testWorkflowPromptFallsBackToLegacySteps(): void
    {
        $prompt = GenesisProposer::buildWorkflowPrompt(
            [
                'id' => 7,
                'name' => 'Newsletter Pipeline',
                'description' => 'crypto+pubmed → publisher',
                'steps' => json_encode([
                    ['name' => 'Researcher', 'type' => 'agent', 'instructions' => 'Research crypto news daily'],
                ]),
            ],
            [['input_variables' => ['topic' => 'crypto']]],
            []
        );
        $this->assertStringContainsString('STRUCTURE', $prompt);
        $this->assertStringContainsString('Researcher', $prompt);
        $this->assertStringContainsString('Research crypto news daily', $prompt);
    }

    public function testWorkflowPromptStructureUnavailableWhenNeitherPresent(): void
    {
        $prompt = GenesisProposer::buildWorkflowPrompt(
            ['id' => 7, 'name' => 'Empty Pipeline', 'description' => null],
            [],
            []
        );
        $this->assertStringContainsString('STRUCTURE: (not available)', $prompt);
    }
}
