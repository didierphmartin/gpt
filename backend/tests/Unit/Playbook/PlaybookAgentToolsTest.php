<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\PlaybookAgentTools;

/**
 * A playbook agent's `tools` = the MCP tools its #Actions bind to (as the
 * runtime names them, mcp_<tool>), so the agent form's checkboxes show what
 * the playbook needs. Native verbs and unbound actions contribute nothing.
 */
class PlaybookAgentToolsTest extends TestCase
{
    public function testBoundMcpToolsBecomeTheAgentTools(): void
    {
        $text = "Title: T\n\nTrigger: x\n\nInstructions:\n1. #Custom Workday Get PTO Balance for the requester.\n"
            . "2. #Lookup Users on the requester.\n3. #Custom Frobnicate Widgets.\n4. #Send Direct Message; #Resolve Request.\n\n"
            . "Tools used: Workday\n\nActions used: #Custom Workday Get PTO Balance; #Lookup Users; #Custom Frobnicate Widgets; #Send Direct Message; #Resolve Request";
        $available = ['workday.get_pto_balance', 'workday.submit_time_off', 'okta.lookup_users'];
        $this->assertSame(['mcp_get_pto_balance', 'mcp_lookup_users'], PlaybookAgentTools::fromPlaybookText($text, $available));
    }

    public function testUnparseableTextYieldsNoTools(): void
    {
        $this->assertSame([], PlaybookAgentTools::fromPlaybookText('not a playbook', ['okta.lookup_users']));
    }
}
