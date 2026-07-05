<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\MAFGenerator;

final class MafGeneratorCompileTest extends TestCase
{
    private static function python3Available(): bool
    { exec('command -v python3 2>/dev/null', $o, $rc); return $rc === 0; }

    private static function pyCompile(string $code, string $suffix = 'test'): array
    {
        $tmp = sys_get_temp_dir() . "/maf_{$suffix}_" . getmypid() . '.py';
        file_put_contents($tmp, $code);
        exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
        @unlink($tmp);
        return [$rc, implode("\n", $out)];
    }

    private static function diamondAnalyzed(): array
    {
        return [
            'workflow' => ['id' => 9, 'name' => 'Diamond'],
            'byId' => [
                '1' => ['id'=>'1','type'=>'start','config'=>[]],
                '2' => ['id'=>'2','type'=>'agent','config'=>[]],
                '3' => ['id'=>'3','type'=>'agent','config'=>[]],
                '4' => ['id'=>'4','type'=>'agent','config'=>[]],
                '5' => ['id'=>'5','type'=>'output','config'=>[]],
            ],
            'layers' => [['1'], ['2','3'], ['4'], ['5']],
            'parents' => ['2'=>['1'],'3'=>['1'],'4'=>['2','3'],'5'=>['4']],
            'startNodeId' => '1',
            'agents' => [
                '2'=>['name'=>'A','systemPrompt'=>'A','provider'=>'claude','model'=>'m','temperature'=>null,'max_tokens'=>null,'tools'=>[],'skill_content'=>'','skills'=>[],'documents'=>[]],
                '3'=>['name'=>'B','systemPrompt'=>'B','provider'=>'openai','model'=>'gpt-4o','temperature'=>null,'max_tokens'=>null,'tools'=>[],'skill_content'=>'','skills'=>[],'documents'=>[]],
                '4'=>['name'=>'C','systemPrompt'=>'C','provider'=>'gemini','model'=>'gemini-2.5-flash','temperature'=>null,'max_tokens'=>null,'tools'=>[],'skill_content'=>'','skills'=>[],'documents'=>[]],
            ],
            'usedCatalog'=>[], 'usedServers'=>[], 'startPrompt'=>'go', 'startDocuments'=>[],
            'outputStorageEnabled'=>true, 'outputFolder'=>null,
        ];
    }

    public function testDiamondCompiles(): void
    {
        if (!self::python3Available()) { $this->markTestSkipped('python3 not on PATH'); }
        [$rc, $out] = self::pyCompile(MAFGenerator::emitMaf(self::diamondAnalyzed()), 'diamond');
        $this->assertSame(0, $rc, "Diamond MAF failed py_compile:\n{$out}");
    }

    public function testSkillFixtureCompiles(): void
    {
        if (!self::python3Available()) { $this->markTestSkipped('python3 not on PATH'); }
        $a = self::diamondAnalyzed();
        $a['agents']['4']['skills'] = [['dir' => 'html']];   // consolidator renders HTML
        [$rc, $out] = self::pyCompile(MAFGenerator::emitMaf($a), 'skill');
        $this->assertSame(0, $rc, "Skill MAF failed py_compile:\n{$out}");
    }

    public function testMcpFixtureCompiles(): void
    {
        if (!self::python3Available()) { $this->markTestSkipped('python3 not on PATH'); }
        $a = self::diamondAnalyzed();
        $a['usedServers'] = ['https://mcp.example/mcp' => ['url' => 'https://mcp.example/mcp']];
        $a['usedCatalog'] = ['web_search' => [
            'server_url' => 'https://mcp.example/mcp', 'tool_name' => 'web_search',
            'input_schema' => ['type'=>'object','properties'=>['q'=>['type'=>'string']],'required'=>['q']],
        ]];
        $a['agents']['2']['tools'] = ['web_search'];
        [$rc, $out] = self::pyCompile(MAFGenerator::emitMaf($a), 'mcp');
        $this->assertSame(0, $rc, "MCP MAF failed py_compile:\n{$out}");
    }
}
