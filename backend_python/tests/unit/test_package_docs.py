"""MODEL_NAME in .env.example and the README's Configure list exactly when the program reads it
(twin of ExportReadmeTest::testModelNameIsListedOnlyWhenTheProgramReadsIt)."""
from app.agent_team.services.compiled_package import CompiledPackage
from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.package_docs import PackageDocs


def test_model_name_is_listed_only_when_the_program_reads_it():
    assert LangGraphPackage.envVariables({})['model'] == "One model for every node, instead of each node's own"
    assert CompiledPackage.envVariables({'playbooks': {}})['model'] is None
    pb = CompiledPackage.envVariables({'playbooks': {'7': {'provider': 'claude'}}})
    assert pb['model'] == "One model for every playbook node, instead of each node's own"

    env = PackageDocs.envExample('W', pb, [])
    assert "# Optional\n# One model for every playbook node, instead of each node's own\n# MODEL_NAME=\n" in env
    assert "- `MODEL_NAME` -- optional: one model for every playbook node, instead of each node's own.\n" \
        in '\n'.join(PackageDocs.head('W', [], 'w', pb))
    none = {**pb, 'model': None}
    assert 'MODEL_NAME' not in PackageDocs.envExample('W', none, [])
    assert 'MODEL_NAME' not in '\n'.join(PackageDocs.head('W', [], 'w', none))


def test_mcp_servers_says_each_address_can_be_moved_without_a_compile():
    """Twin of ReadmeAboutAndServerSettingsTest::testMcpServersSaysEachAddressCanBeMovedWithoutACompile."""
    vars = {'keys': {}, 'decision': {}, 'model': None,
            'mcp': {'http://localhost:8790/outlook_mcp/mcp': 'outlook', 'http://h:9/sp|x': 'sharepoint'}}
    md = '\n'.join(PackageDocs.head('W', [], 'w', vars))
    assert '## MCP servers\n\nThe MCP servers are not part of this folder' in md
    assert '| outlook | `http://localhost:8790/outlook_mcp/mcp` | `MCP_URL_OUTLOOK` | `MCP_HEADERS_OUTLOOK` |' in md
    assert '| sharepoint | `http://h:9/sp\\|x` | `MCP_URL_SHAREPOINT` | `MCP_HEADERS_SHAREPOINT` |' in md
    assert 'e.g. `MCP_URL_OUTLOOK=http://mcp.example.com:8790/mcp`' in md
    assert md.index('## MCP servers') > md.index('## Configure')
    assert PackageDocs.mcpServers({}) == []
