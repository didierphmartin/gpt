-- ServiceNow MCP server 125: switch from the mock to the live PDI (dev366449) connector.
-- Dev instance only. Runs against the CONTEXTS database (netfo587_chatbot).
-- To go back to the mock:
--   UPDATE mcp_servers SET url = 'http://localhost/servicenow/mock/jobs', is_mock = 1 WHERE id = 125;
UPDATE mcp_servers SET url = 'http://localhost/servicenow/pdi/jobs', is_mock = 0 WHERE id = 125;
