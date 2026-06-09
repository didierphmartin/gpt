# Workflow System Documentation

## Overview

The Workflow System provides a visual graph-based approach to orchestrating AI agents, enabling complex multi-step operations with conditional logic, parallel execution, and external integrations. Workflows are represented as directed graphs where **nodes** represent processing units and **edges** define the flow of data between them.

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Node Types](#node-types)
3. [Workflow as a Collection of Linked Nodes](#workflow-as-a-collection-of-linked-nodes)
4. [API Endpoints](#api-endpoints)
5. [Database Schema](#database-schema)
6. [Frontend-Backend Interaction](#frontend-backend-interaction)
7. [Workflow Execution Flow](#workflow-execution-flow)
8. [SSE Real-Time Events](#sse-real-time-events)
9. [Output Storage](#output-storage)
10. [Error Handling](#error-handling)
11. [Prompt Template Variables](#prompt-template-variables)
12. [Node Type Definitions](#node-type-definitions)
13. [Execution Paths: Conversation vs Workflow](#execution-paths-conversation-vs-workflow)

---

## Core Concepts

### What is a Workflow?

A workflow is a **directed acyclic graph (DAG)** consisting of:
- **Nodes**: Processing units that perform specific actions (run an AI agent, evaluate conditions, merge outputs, etc.)
- **Edges**: Connections that define how data flows from one node to another

### Key Principles

1. **Graph-Based Design**: Workflows are visual graphs, not linear sequences
2. **Data Flow**: Each node receives input from connected upstream nodes and produces output for downstream nodes
3. **Parallel Execution**: Multiple nodes can execute simultaneously when they have no dependencies on each other
4. **Streaming Updates**: Real-time progress updates via Server-Sent Events (SSE)

---

## Node Types

### Special Nodes

#### Start Node
- **Type**: `start`
- **Purpose**: Entry point of the workflow
- **Inputs**: None (receives user prompt/variables)
- **Outputs**: User prompt passed to connected nodes
- **Rules**:
  - Exactly one Start node per workflow
  - Must have at least one outgoing connection

```json
{
  "node_type": "start",
  "config": { "type": "start" }
}
```

##### Delayed/Scheduled Execution

The Start node supports **delayed execution** for scheduling workflows to run at a later time or on a recurring schedule. This is configured at the workflow level via triggers.

**Trigger Types**:

| Type | Description |
|------|-------------|
| `manual` | User-initiated execution (default) |
| `scheduled` | Run at a specific date/time |
| `recurring` | Run on a cron-like schedule |
| `webhook` | Triggered by external HTTP call |
| `api` | Triggered via API endpoint |

**Scheduled Execution Configuration**:
```json
{
  "triggers": {
    "type": "scheduled",
    "schedule": {
      "datetime": "2024-01-20T09:00:00Z",
      "timezone": "America/New_York"
    }
  }
}
```

**Recurring Execution (Cron-style)**:
```json
{
  "triggers": {
    "type": "recurring",
    "schedule": {
      "cron": "0 9 * * 1-5",
      "timezone": "Europe/Paris"
    }
  }
}
```

**Cron Expression Examples**:
- `0 9 * * *` - Daily at 9:00 AM
- `0 9 * * 1-5` - Weekdays at 9:00 AM
- `0 */6 * * *` - Every 6 hours
- `0 0 1 * *` - First day of each month at midnight

**Backend Scheduler**:
- The scheduler runs via cron job calling `/api/v1/scheduler/run`
- Checks `agent_workflows` for enabled workflows with due triggers
- Executes workflows in background (no SSE - results stored to output storage)
- Configured in `ai_config.php` under `scheduler` section:
  ```php
  'scheduler' => [
      'token' => 'secret-token',      // Auth token for scheduler endpoint
      'max_concurrent' => 5,           // Max parallel workflow executions
      'timeout_minutes' => 30,         // Max execution time per workflow
  ]
  ```

#### Output Node
- **Type**: `output`
- **Purpose**: Collects and returns the final workflow result
- **Inputs**: Receives data from upstream nodes
- **Outputs**: None (terminal node)
- **Rules**:
  - At least one Output node per workflow
  - Must have at least one incoming connection

```json
{
  "node_type": "output",
  "config": { "type": "output" }
}
```

##### File Storage

The Output node can automatically save workflow results to various storage providers. This is especially important for **scheduled/delayed executions** where no frontend is present to receive the results.

**Enabling Output Storage**:

Storage is configured at the workflow level:
```json
{
  "output_storage_enabled": true,
  "output_folder": "research-reports"
}
```

**Storage Providers**:

| Provider | Key | Description |
|----------|-----|-------------|
| Local File System | `local` | Saves to server filesystem (default fallback) |
| Amazon S3 | `s3` | AWS S3 bucket storage |
| Google Drive | `gdrive` | Google Drive cloud storage |
| Microsoft OneDrive | `onedrive` | OneDrive cloud storage |

**Storage Configuration Hierarchy**:
1. **Workflow-level**: `agent_workflows.output_folder` (highest priority)
2. **User-level**: `users.storage_provider`, `users.storage_folder`
3. **System default**: Local filesystem

**Output File Structure**:

Path: `{storage_root}/{user_folder}/{workflow_folder}/{filename}`

Filename format: `{WorkflowName}_{YYYY-MM-DD_HH-mm-ss}.json`

**Stored Output Content**:
```json
{
  "execution_id": 1001,
  "workflow_id": 42,
  "workflow_name": "Daily Research Report",
  "timestamp": "2024-01-15T09:00:00Z",
  "response_time_ms": 45230,
  "nodes_executed": 5,
  "success": true,
  "output": "Final merged report content...",
  "node_outputs": {
    "1": { "type": "start", "output": "Generate daily market report" },
    "2": { "type": "agent", "output": "...", "agent_name": "Market Analyzer" },
    "3": { "type": "agent", "output": "...", "agent_name": "News Summarizer" },
    "4": { "type": "merge", "output": "..." },
    "5": { "type": "output", "output": "..." }
  },
  "input_variables": {
    "prompt": "Generate daily market report"
  }
}
```

**Retrieving Stored Outputs**:
```
GET /api/v1/workflows/{id}/outputs
GET /api/v1/workflows/{id}/outputs/{filename}
```

### Agent Nodes

#### Standard Agent Node
- **Type**: `agent`
- **Purpose**: Executes an AI agent (LLM) with optional tools
- **Configuration**:

```json
{
  "node_type": "agent",
  "agent_id": 123,
  "config": {
    "type": "agent",
    "agent_name": "Research Assistant",
    "agent_id": 123,
    "agent_provider": "openai",
    "model": "gpt-4o",
    "instructions": "You are a helpful research assistant...",
    "tools": ["serpapi_search", "get_crypto_news"],
    "agent_type": "research",
    "settings": {
      "temperature": 0.7,
      "max_tokens": 4096
    }
  }
}
```

**Agent Modes**:
1. **Reference Mode**: Uses `agent_id` to load a pre-configured agent from the database
2. **Inline Mode**: Defines agent configuration directly in the node (no `agent_id`)

### Control Flow Nodes

#### Condition Node
- **Type**: `condition`
- **Purpose**: Binary branching based on a condition
- **Outputs**: Two branches - `true` (output_1) and `false` (output_2)

```json
{
  "node_type": "condition",
  "config": {
    "type": "condition",
    "condition": "contains:approved"
  }
}
```

**Supported Conditions**:
- `contains:text` - Check if output contains text
- `!contains:text` - Check if output does NOT contain text
- `length>N` - Check if output length exceeds N
- `empty` / `!empty` - Check if output is empty or not

#### Switch Node
- **Type**: `switch`
- **Purpose**: Multi-way branching (more than 2 paths)
- **Outputs**: Multiple output ports (output_1, output_2, output_3, ...)

```json
{
  "node_type": "switch",
  "config": {
    "type": "switch",
    "cases": [
      { "condition": "contains:option_a" },
      { "condition": "contains:option_b" },
      { "condition": "default" }
    ]
  }
}
```

#### Implicit Parallel Execution

Parallel execution is **automatically inferred** from the graph structure. When any node has **multiple outgoing connectors** to agent nodes, those agents execute in parallel.

**No explicit Parallel node is needed.** Simply connect multiple agents from the same source:

```
Start → [Agent1, Agent2, Agent3] → Merge → Output
```

The workflow runner detects multiple outgoing edges to agents and executes them concurrently using `curl_multi` for true parallel HTTP requests.

#### Merge Node
- **Type**: `merge`
- **Purpose**: Fan-in to collect outputs from multiple upstream nodes
- **Output**: Combined markdown with section headers for each input source

```json
{
  "node_type": "merge",
  "config": { "type": "merge" }
}
```

**Merge Output Format**:
```markdown
## Agent 1 Name

[Agent 1 output]

---

## Agent 2 Name

[Agent 2 output]
```

### Integration Nodes

#### MCP Node
- **Type**: `mcp`
- **Purpose**: Call external MCP (Model Context Protocol) servers
- **Protocol**: JSON-RPC 2.0

```json
{
  "node_type": "mcp",
  "config": {
    "type": "mcp",
    "mcp_server_url": "https://mcp-server.example.com/mcp",
    "mcp_server_name": "Data Processing Server",
    "functions": [
      {
        "name": "process_data",
        "enabled": true,
        "parameters": { "format": "json" }
      }
    ]
  }
}
```

---

## Workflow as a Collection of Linked Nodes

### Graph Structure

A workflow graph consists of:

1. **Nodes Collection**: Array of node definitions
2. **Edges Collection**: Array of connections between nodes

### Edge Definition

Each edge connects an output port of one node to an input port of another:

```json
{
  "id": "edge_1",
  "from_node_id": 1,
  "to_node_id": 2,
  "from_port": "output_1",
  "to_port": "input_1",
  "condition_expr": null
}
```

**Port Naming Convention**:
- Input ports: `input_1` (most nodes have single input)
- Output ports: `output_1`, `output_2`, etc.
- Condition nodes: `output_1` (true branch), `output_2` (false branch)

### Example Workflow Graph

```
[Start] → [Agent: Analyzer] → [Condition: IsPositive?]
                                    ↓ true         ↓ false
                              [Agent: Promoter] [Agent: Critic]
                                    ↓                 ↓
                                    └──→ [Merge] ←────┘
                                            ↓
                                        [Output]
```

**Nodes**:
```json
[
  { "id": 1, "node_type": "start" },
  { "id": 2, "node_type": "agent", "config": { "agent_name": "Analyzer" } },
  { "id": 3, "node_type": "condition", "config": { "condition": "contains:positive" } },
  { "id": 4, "node_type": "agent", "config": { "agent_name": "Promoter" } },
  { "id": 5, "node_type": "agent", "config": { "agent_name": "Critic" } },
  { "id": 6, "node_type": "merge" },
  { "id": 7, "node_type": "output" }
]
```

**Edges**:
```json
[
  { "from_node_id": 1, "to_node_id": 2 },
  { "from_node_id": 2, "to_node_id": 3 },
  { "from_node_id": 3, "to_node_id": 4, "from_port": "output_1" },
  { "from_node_id": 3, "to_node_id": 5, "from_port": "output_2" },
  { "from_node_id": 4, "to_node_id": 6 },
  { "from_node_id": 5, "to_node_id": 6 },
  { "from_node_id": 6, "to_node_id": 7 }
]
```

---

## API Endpoints

### Workflow Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/workflows` | List all workflows for authenticated user |
| POST | `/api/v1/workflows` | Create new workflow |
| GET | `/api/v1/workflows/{id}` | Get workflow details (add `?include_graph=true` for full graph) |
| PUT | `/api/v1/workflows/{id}` | Update workflow |
| DELETE | `/api/v1/workflows/{id}` | Delete workflow (cascades to nodes, edges, executions) |
| POST | `/api/v1/workflows/{id}/toggle` | Enable/disable workflow |
| POST | `/api/v1/workflows/{id}/duplicate` | Clone workflow |

### Workflow Execution

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/workflows/{id}/run` | Execute workflow synchronously |
| POST | `/api/v1/workflows/{id}/run-stream` | Execute with SSE streaming |
| GET | `/api/v1/workflows/{id}/executions` | Get execution history |

### Output Storage

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/workflows/{id}/outputs` | List saved output files |
| GET | `/api/v1/workflows/{id}/outputs/{filename}` | Get specific output file |

### Request/Response Examples

#### Create Workflow

**Request**:
```json
POST /api/v1/workflows
{
  "name": "Research Pipeline",
  "description": "Multi-agent research workflow",
  "graph": {
    "nodes": [...],
    "edges": [...]
  }
}
```

**Response**:
```json
{
  "success": true,
  "workflow": {
    "id": 42,
    "name": "Research Pipeline",
    "description": "Multi-agent research workflow",
    "enabled": true,
    "created_at": "2024-01-15T10:30:00Z"
  }
}
```

#### Run Workflow (Streaming)

**Request**:
```json
POST /api/v1/workflows/42/run-stream
{
  "variables": {
    "prompt": "Research the latest developments in quantum computing"
  }
}
```

**Response**: Server-Sent Events stream (see [SSE Events](#sse-real-time-events))

---

## Database Schema

### Primary Tables

#### `agent_workflows`
Main workflow definition table.

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| user_id | INT | Owner user ID |
| workspace_id | INT | Optional workspace |
| name | VARCHAR(255) | Workflow name |
| description | TEXT | Workflow description |
| triggers | JSON | API/schedule/webhook triggers |
| variables | JSON | Input variable definitions |
| enabled | BOOLEAN | Whether workflow can be executed |
| output_storage_enabled | BOOLEAN | Auto-save outputs |
| output_folder | VARCHAR | Custom output folder |
| created_at | TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | Last update time |

#### `workflow_nodes`
Graph nodes for each workflow.

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| workflow_id | INT | FK to agent_workflows |
| node_type | ENUM | start, output, agent, condition, switch, merge, mcp |
| agent_id | INT | FK to agents table (nullable) |
| config | JSON | Node-specific configuration |
| pos_x | INT | Canvas X position |
| pos_y | INT | Canvas Y position |
| drawflow_node_id | VARCHAR | Frontend Drawflow ID |
| created_at | TIMESTAMP | Creation time |

#### `workflow_edges`
Connections between nodes.

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| workflow_id | INT | FK to agent_workflows |
| from_node_id | INT | FK to source workflow_node |
| to_node_id | INT | FK to target workflow_node |
| from_port | VARCHAR(50) | Source port (e.g., output_1) |
| to_port | VARCHAR(50) | Target port (e.g., input_1) |
| condition_expr | TEXT | Optional routing condition |
| created_at | TIMESTAMP | Creation time |

#### `agent_workflow_executions`
Execution history and results.

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| workflow_id | INT | FK to agent_workflows |
| user_id | INT | User who ran the workflow |
| input_variables | JSON | Variables passed to workflow |
| status | ENUM | running, completed, failed |
| output | JSON | All node outputs |
| response_time_ms | INT | Total execution time |
| started_at | TIMESTAMP | Execution start |
| completed_at | TIMESTAMP | Execution end |
| error_message | TEXT | Error details if failed |

---

## Frontend-Backend Interaction

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Browser)                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Workflow Editor (Drawflow)             │    │
│  │  - Visual node editor                               │    │
│  │  - Drag-and-drop node creation                      │    │
│  │  - Connection drawing                               │    │
│  │  - Node configuration panels                        │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                 │
│                    Fetch API / SSE                          │
└───────────────────────────┼─────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────┐
│                     Backend (PHP)                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              WorkflowController                     │    │
│  │  - REST API endpoints                               │    │
│  │  - Request validation                               │    │
│  │  - Authentication                                   │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         │                                   │
│  ┌──────────────────────┴──────────────────────────────┐    │
│  │            GraphWorkflowRunner                      │    │
│  │  - Graph traversal (BFS)                            │    │
│  │  - Node execution dispatch                          │    │
│  │  - Parallel execution (curl_multi)                  │    │
│  │  - SSE event emission                               │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Database (MySQL)                       │    │
│  │  - agent_workflows                                  │    │
│  │  - workflow_nodes                                   │    │
│  │  - workflow_edges                                   │    │
│  │  - agent_workflow_executions                        │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Communication Flow

#### 1. Loading a Workflow

```
Frontend                              Backend
   │                                     │
   │  GET /api/v1/workflows/42           │
   │  ?include_graph=true                │
   │────────────────────────────────────>│
   │                                     │
   │  {                                  │
   │    id: 42,                          │
   │    name: "...",                     │
   │    graph: {                         │
   │      nodes: [...],                  │
   │      edges: [...]                   │
   │    }                                │
   │  }                                  │
   │<────────────────────────────────────│
   │                                     │
   │  Render nodes in Drawflow           │
   │  Draw connections                   │
```

#### 2. Saving a Workflow

```
Frontend                              Backend
   │                                     │
   │  Export Drawflow graph              │
   │  Convert to API format              │
   │                                     │
   │  PUT /api/v1/workflows/42           │
   │  {                                  │
   │    name: "...",                     │
   │    graph: { nodes, edges }          │
   │  }                                  │
   │────────────────────────────────────>│
   │                                     │
   │                      Validate graph │
   │                      Save to DB     │
   │                      (transaction)  │
   │                                     │
   │  { success: true, ... }             │
   │<────────────────────────────────────│
```

#### 3. Running a Workflow (Streaming)

```
Frontend                              Backend
   │                                     │
   │  POST /api/v1/workflows/42/run-stream
   │  { variables: { prompt: "..." } }   │
   │────────────────────────────────────>│
   │                                     │
   │         SSE Connection Established  │
   │                                     │
   │  event: workflow_start              │
   │<────────────────────────────────────│
   │                                     │
   │  event: node_start (node 1)         │
   │<────────────────────────────────────│
   │                                     │
   │  event: node_complete (node 1)      │
   │<────────────────────────────────────│
   │                                     │
   │  ... more node events ...           │
   │                                     │
   │  event: workflow_complete           │
   │  { output, node_outputs, ... }      │
   │<────────────────────────────────────│
   │                                     │
   │  Close SSE connection               │
   │  Display results                    │
```

### Frontend Key Components

#### WorkflowEditor Class (`workflow-editor.js`)

```javascript
class WorkflowEditor {
  constructor(containerId) {
    this.editor = new Drawflow(container);
    this.editor.start();
  }

  // Node Management
  addNode(type, config, position) { ... }
  removeNode(nodeId) { ... }
  updateNodeConfig(nodeId, config) { ... }

  // Workflow Operations
  async saveWorkflow() { ... }
  async loadWorkflow(workflowId) { ... }
  async runWorkflow(variables) { ... }

  // SSE Handling
  startNodeTimer(nodeId) { ... }
  stopNodeTimer(nodeId) { ... }
  highlightNode(nodeId, status) { ... }
  showWorkflowResults(data) { ... }
}
```

---

## Workflow Execution Flow

### GraphWorkflowRunner Execution Steps

```
1. INITIALIZATION
   ├── Create execution record
   ├── Find Start node
   ├── Store user prompt as Start output
   └── Emit workflow_start event

2. GRAPH TRAVERSAL (BFS)
   ├── Initialize queue with Start node successors
   ├── While queue not empty:
   │   ├── Dequeue next node
   │   ├── Check dependencies (all inputs executed?)
   │   │   ├── No → Re-queue node
   │   │   └── Yes → Execute node
   │   ├── Execute node based on type
   │   ├── Store output
   │   ├── Emit node_complete event
   │   └── Queue successor nodes

3. NODE EXECUTION (by type)
   ├── agent → Run LLM with tools
   ├── condition → Evaluate expression, set branch
   ├── switch → Match case, set output port
   ├── merge → Combine all inputs
   ├── mcp → Call external MCP server
   └── output → Collect final result

4. PARALLEL EXECUTION (implicit from graph structure)
   ├── Detect multiple outgoing edges to agent nodes
   ├── Initialize curl_multi handles
   ├── Execute LLM calls concurrently
   ├── Handle tool calls per agent
   └── Collect all results

5. COMPLETION
   ├── Collect all node outputs
   ├── Update execution record
   ├── Save to output storage (if enabled)
   └── Emit workflow_complete event
```

### Dependency Resolution

Before executing a node, the runner checks that all upstream nodes have completed:

```php
private function canExecuteNode(int $nodeId, array $edges, array $executedNodes): bool
{
    foreach ($edges as $edge) {
        if ($edge['to_node_id'] === $nodeId) {
            if (!in_array($edge['from_node_id'], $executedNodes)) {
                return false; // Dependency not yet executed
            }
        }
    }
    return true;
}
```

### Conditional Routing

For condition nodes, the output determines which branch to follow:

```php
// Condition node output
$output = [
    'type' => 'condition',
    'branch' => $result ? 'true' : 'false',
    'output' => $inputText
];

// Edge selection in getNextNodeIds()
if ($nodeOutput['branch'] === 'true') {
    // Follow output_1 edge
} else {
    // Follow output_2 edge
}
```

---

## SSE Real-Time Events

### Event Types

#### workflow_start
Emitted when workflow execution begins.

```json
{
  "type": "workflow_start",
  "workflow_id": 42,
  "workflow_name": "Research Pipeline",
  "execution_id": 1001,
  "total_nodes": 7,
  "timestamp": 1705312200.123
}
```

#### node_start
Emitted when a node begins execution.

```json
{
  "type": "node_start",
  "node_id": 2,
  "node_type": "agent",
  "drawflow_id": "node-2",
  "agent_id": 123,
  "timestamp": 1705312201.456
}
```

#### node_complete
Emitted when a node finishes execution.

```json
{
  "type": "node_complete",
  "node_id": 2,
  "node_type": "agent",
  "agent_name": "Research Assistant",
  "success": true,
  "timestamp": 1705312205.789
}
```

#### node_error
Emitted when a node fails.

```json
{
  "type": "node_error",
  "node_id": 2,
  "node_type": "agent",
  "error": "LLM API timeout",
  "success": false,
  "timestamp": 1705312210.123
}
```

#### workflow_complete
Emitted when workflow finishes successfully.

```json
{
  "type": "workflow_complete",
  "workflow_id": 42,
  "workflow_name": "Research Pipeline",
  "execution_id": 1001,
  "success": true,
  "nodes_executed": 7,
  "response_time_ms": 15234,
  "output": "Final merged output text...",
  "node_outputs": {
    "1": { "type": "start", "output": "User prompt..." },
    "2": { "type": "agent", "output": "Agent response...", "agent_name": "..." }
  },
  "timestamp": 1705312215.456
}
```

#### workflow_error
Emitted when workflow fails.

```json
{
  "type": "workflow_error",
  "workflow_id": 42,
  "error": "MCP server unreachable",
  "execution_id": 1001,
  "timestamp": 1705312220.789
}
```

### Frontend SSE Handling

```javascript
async runWorkflow(variables) {
  const response = await fetch(`/api/v1/workflows/${this.workflowId}/run-stream`, {
    method: 'POST',
    body: JSON.stringify({ variables })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value).split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const event = JSON.parse(line.slice(6));
        this.handleSSEEvent(event);
      }
    }
  }
}

handleSSEEvent(event) {
  switch (event.type) {
    case 'workflow_start':
      this.resetNodeStates();
      break;
    case 'node_start':
      this.highlightNode(event.node_id, 'active');
      this.startNodeTimer(event.node_id);
      break;
    case 'node_complete':
      this.highlightNode(event.node_id, 'completed');
      this.stopNodeTimer(event.node_id);
      break;
    case 'node_error':
      this.highlightNode(event.node_id, 'error');
      this.stopNodeTimer(event.node_id);
      break;
    case 'workflow_complete':
      this.showWorkflowResults(event);
      break;
  }
}
```

---

## Output Storage

### Storage Providers

| Provider | Description |
|----------|-------------|
| `local` | Local file system (default) |
| `s3` | Amazon S3 bucket |
| `gdrive` | Google Drive |
| `onedrive` | Microsoft OneDrive |

### Storage Configuration

- **User-level defaults**: `users.storage_provider`, `users.storage_folder`
- **Workflow overrides**: `agent_workflows.output_folder`

### Output File Format

Filename: `{WorkflowName}_{YYYY-MM-DD_HH-mm-ss}.json`

```json
{
  "execution_id": 1001,
  "workflow_id": 42,
  "workflow_name": "Research Pipeline",
  "timestamp": "2024-01-15T10:30:00Z",
  "response_time_ms": 15234,
  "nodes_executed": 7,
  "output": "Final output text...",
  "node_outputs": {
    "1": { ... },
    "2": { ... }
  },
  "input_variables": {
    "prompt": "Original user prompt..."
  }
}
```

---

## Error Handling

### Graph Validation Errors

| Error | Description |
|-------|-------------|
| Missing Start node | Workflow must have exactly one Start node |
| Multiple Start nodes | Only one Start node allowed |
| Missing Output node | Workflow must have at least one Output node |
| Disconnected nodes | All nodes (except Start/Output) must be connected |
| Start not connected | Start node must connect to at least one other node |
| Output not connected | Output node must have at least one incoming edge |

### Execution Errors

| Error | Handling |
|-------|----------|
| MCP node failure | Stops workflow immediately |
| Agent node failure | Records error, continues if possible |
| Database connection lost | Attempts reconnection |
| LLM API timeout | Returns partial results with error |

### Error Response Format

```json
{
  "success": false,
  "error": "Error message description",
  "execution_id": 1001,
  "partial_outputs": { ... }
}
```

---

## Best Practices

### Workflow Design

1. **Start Simple**: Begin with linear workflows before adding branches
2. **Use Merge Nodes**: Always use Merge to combine parallel branches
3. **Name Agents Clearly**: Use descriptive names for easy identification
4. **Limit Parallel Agents**: Too many parallel agents can overwhelm APIs
5. **Test Incrementally**: Test each node before building complex graphs

### Performance

1. **Tool Filtering**: Only enable necessary tools per agent node
2. **Output Storage**: Disable if not needed to reduce I/O
3. **Parallel Execution**: Use for independent tasks that don't need sequential data

### Debugging

1. **Check PHP Logs**: `[GraphWorkflowRunner]` prefix shows execution details
2. **Use SSE Events**: Monitor real-time progress in browser DevTools
3. **Execution History**: Review past runs via `/executions` endpoint
4. **Node Outputs**: Examine individual node outputs in results

---

## Prompt Template Variables

The workflow system supports **dynamic template placeholders** that are automatically replaced with real-time values when agents execute. This is especially useful because LLMs have knowledge cutoff dates and don't know the current date, time, or runtime context.

### Syntax

Template placeholders use square bracket notation: `[placeholder_name]`

### Available Placeholders

#### Date/Time Placeholders

| Placeholder | Description | Example Output |
|-------------|-------------|----------------|
| `[date]` | Current date (full format) | April 7, 2026 |
| `[time]` | Current time | 3:45 PM |
| `[datetime]` | Full date and time | April 7, 2026 3:45 PM |
| `[year]` | Current year | 2026 |
| `[month]` | Current month name | April |
| `[month_num]` | Current month number | 4 |
| `[day]` | Day of month | 7 |
| `[weekday]` | Day of week | Monday |
| `[timezone]` | Current timezone | America/New_York |
| `[iso_date]` | ISO date format | 2026-04-07 |
| `[iso_datetime]` | ISO 8601 datetime | 2026-04-07T15:45:00-04:00 |

#### User Context Placeholders

| Placeholder | Description | Example Output |
|-------------|-------------|----------------|
| `[username]` | Current user's name | John Doe |
| `[user_email]` | User's email address | john@example.com |
| `[user_id]` | User's database ID | 42 |
| `[user_locale]` | User's locale setting | en-US |

#### Workflow Context Placeholders

| Placeholder | Description | Example Output |
|-------------|-------------|----------------|
| `[workflow_name]` | Name of current workflow | Research Pipeline |
| `[workflow_id]` | Workflow database ID | 15 |
| `[agent_name]` | Current agent's name | Market Analyzer |
| `[node_name]` | Current node name | Analysis Node |
| `[node_id]` | Current node database ID | 127 |
| `[user_prompt]` | Original user input | Analyze Bitcoin trends |
| `[previous_output]` | Output from previous node | (previous agent's response) |

#### System Placeholders

| Placeholder | Description | Example Output |
|-------------|-------------|----------------|
| `[app_name]` | Application name | AI Assistant |
| `[app_version]` | Application version | 1.0 |

#### Custom Variables

| Placeholder | Description |
|-------------|-------------|
| `[var:custom_name]` | Custom workflow variable (replace `custom_name` with your variable name) |

### Usage Examples

#### Example 1: Date-Aware Agent Instructions

In your agent's **Instructions** field:

```
You are a research assistant. Today is [date] ([weekday]).
The current year is [year]. Always use this date context when discussing
"recent" or "current" events.

When the user asks about "today's news" or "current trends", you now
know the actual current date.
```

**Processed output:**
```
You are a research assistant. Today is April 7, 2026 (Monday).
The current year is 2026. Always use this date context when discussing
"recent" or "current" events.
```

#### Example 2: Personalized Agent

```
Hello [username], I am [agent_name] working on the "[workflow_name]" workflow.
I'm here to help you with your request.
```

**Processed output:**
```
Hello John Doe, I am Market Analyzer working on the "Research Pipeline" workflow.
I'm here to help you with your request.
```

#### Example 3: Context-Aware Research Agent

```
You are a financial research agent. Current context:
- Date: [iso_date]
- Time: [time] [timezone]
- Workflow: [workflow_name]
- User Query: [user_prompt]

Analyze the request with awareness of the current date for accurate research.
```

### Where Templates Work

Templates are processed in:
- **Agent Instructions** (system prompt)
- **Agent Description**

Templates are processed at execution time, so the values are always current when the workflow runs.

### Backend Implementation

Templates are processed by the `PromptTemplateProcessor` class:

**Location**: `backend/src/AgentTeam/Services/PromptTemplateProcessor.php`

**Key methods**:
- `process(string $prompt): string` - Replaces all placeholders
- `setContext(array $context)` - Sets runtime context values
- `getAvailablePlaceholders(): array` - Returns all available placeholders with descriptions

### Extending with Custom Variables

Custom variables can be defined at the workflow level and accessed via `[var:name]` syntax:

```php
// In workflow config or settings
'custom_vars' => [
    'company_name' => 'Acme Corp',
    'report_type' => 'quarterly',
]
```

Then in agent instructions:
```
Generate a [var:report_type] report for [var:company_name].
```

### Tips

1. **Date Awareness**: Always include `[date]` or `[year]` for agents that need current context
2. **Agent Identity**: Use `[agent_name]` to help agents maintain consistent persona
3. **Workflow Context**: Use `[workflow_name]` for logging or self-referential responses
4. **Unknown Placeholders**: If a placeholder isn't recognized, it's left unchanged (e.g., `[unknown]` stays as `[unknown]`)

---

## Node Type Definitions

### Overview

Node types use a **hybrid architecture**:
- **Frontend (Static)**: Core node types are hardcoded in JavaScript for fast loading
- **Backend (Dynamic)**: User-created agents and MCP templates are fetched via API

### Node Palette Structure

The workflow editor sidebar organizes nodes into collapsible sections:

```
┌─────────────────────────────┐
│ ▼ ESSENTIALS (2)            │  ← FRONTEND (hardcoded)
│   ▶ Start                   │
│   ■ Output                  │
├─────────────────────────────┤
│ ▼ FLOW CONTROL (3)          │  ← FRONTEND (hardcoded)
│   ⑂ Condition               │
│   ⇉ Switch                  │
│   ⨃ Merge                   │
├─────────────────────────────┤
│ ▼ MCP SERVERS (dynamic) [+] │  ← BACKEND (API fetch)
│   (loaded from database)    │
├─────────────────────────────┤
│ ▼ AGENTS (dynamic) [+]      │  ← BACKEND (API fetch)
│   (loaded from database)    │
└─────────────────────────────┘
```

---

### FRONTEND: Static Node Types

**Location**: `frontend/assets/js/workflow-editor.js`

**Method**: `renderAgentsPanel()`

These node types are hardcoded in the frontend JavaScript and require no backend call:

| Type | Section | Icon | Color | data-node-type |
|------|---------|------|-------|----------------|
| Start | Essentials | ▶ | Default | `start` |
| Output | Essentials | ■ | Default | `output` |
| Condition | Flow Control | ⑂ | Yellow (#fef3c7) | `condition` |
| Switch | Flow Control | ⇉ | Indigo (#e0e7ff) | `switch` |
| Merge | Flow Control | ⨃ | Pink (#fce7f3) | `merge` |

> **Note**: Parallel execution is implicit - simply connect multiple agents from a single node. No explicit Parallel node type exists.

**Frontend Code** (`workflow-editor.js:204-286`):
```javascript
// Essentials Section - hardcoded HTML
<div class="workflow-agent-card special start-node"
     draggable="true"
     data-node-type="start">
    <div class="agent-icon">▶</div>
    <div class="agent-info">
        <div class="agent-name">${this.t('workflow.nodes.start')}</div>
        <div class="agent-type">${this.t('workflow.nodes.startDesc')}</div>
    </div>
</div>

// Flow Control Section - hardcoded HTML
<div class="workflow-agent-card special condition-node"
     draggable="true"
     data-node-type="condition">
    <div class="agent-icon" style="background: #fef3c7; color: #d97706;">⑂</div>
    ...
</div>
```

---

### BACKEND: Dynamic Node Types

Dynamic node types are fetched from the database via API endpoints.

#### Agent Nodes

**Frontend Location**: `frontend/assets/js/workflow-editor.js`
- Method: `renderAgentsPanel()` uses `workflowAgents` array passed to constructor

**Backend Location**: `backend/src/Controllers/AgentTeamController.php`
- Method: `getAgents()`
- Table: `agents` (filtered by `category = 'workflow'`)

**API Endpoint**:
```
GET /api/v1/agents?category=workflow
```

**Backend Response**:
```json
{
  "success": true,
  "agents": [
    {
      "id": 123,
      "name": "Research Assistant",
      "type": "research",
      "provider": "openai",
      "model": "gpt-4o",
      "instructions": "You are a helpful research assistant...",
      "tools": ["serpapi_search", "get_crypto_news"],
      "color": "#4f46e5"
    }
  ]
}
```

**Frontend Rendering**:
```javascript
// Rendered from workflowAgents array in renderAgentsPanel()
<div class="workflow-agent-card"
     draggable="true"
     data-node-type="agent"
     data-agent-id="${agent.id}">
    <div class="agent-icon" style="background: ${agent.color};">🤖</div>
    <div class="agent-info">
        <div class="agent-name">${agent.name}</div>
        <div class="agent-type">${agent.type}</div>
    </div>
</div>
```

#### MCP Template Nodes

**Frontend Location**: `frontend/assets/js/workflow-editor.js`
- Method: `loadMCPTemplates()` - called after editor initialization

**Backend Location**: `backend/src/Controllers/MCPController.php`
- Method: `getTemplates()`
- Table: `mcp_templates`

**API Endpoint**:
```
GET /api/v1/mcp-templates
```

**Backend Response**:
```json
{
  "success": true,
  "templates": [
    {
      "id": 1,
      "name": "Data Processing Server",
      "url": "https://mcp-server.example.com/mcp",
      "functions": [
        { "name": "process_data", "description": "Process input data" }
      ]
    }
  ]
}
```

**Frontend Rendering**:
```javascript
// Rendered in loadMCPTemplates()
<div class="workflow-agent-card mcp-template"
     draggable="true"
     data-node-type="mcp"
     data-mcp-id="${template.id}">
    <div class="agent-icon mcp-icon">🔌</div>
    <div class="agent-info">
        <div class="agent-name">${template.name}</div>
        <div class="agent-type">MCP Server</div>
    </div>
</div>
```

---

### FRONTEND: Node Creation from Palette

**Location**: `frontend/assets/js/workflow-editor.js`

When a node is dragged from the palette onto the canvas, the `data-node-type` attribute determines which creation method is called:

```javascript
handleNodeDrop(event) {
    const nodeType = event.target.dataset.nodeType;
    const agentId = event.target.dataset.agentId;
    const mcpId = event.target.dataset.mcpId;

    switch (nodeType) {
        // Static types (no backend call needed)
        case 'start':
            this.addStartNode(x, y);
            break;
        case 'output':
            this.addOutputNode(x, y);
            break;
        case 'condition':
            this.addConditionNode(x, y);
            break;
        case 'switch':
            this.addSwitchNode(x, y);
            break;
        case 'merge':
            this.addMergeNode(x, y);
            break;

        // Dynamic types (use data from backend)
        case 'agent':
            this.addAgentNode(x, y, agentId);  // agentId from backend
            break;
        case 'mcp':
            this.addMCPNode(x, y, mcpId);      // mcpId from backend
            break;
    }
    // Note: Parallel execution is implicit - connect multiple agents from one node
}
```

---

### Summary: Frontend vs Backend

| Aspect | Frontend | Backend |
|--------|----------|---------|
| **File** | `workflow-editor.js` | `AgentTeamController.php`, `MCPController.php` |
| **Static Types** | Hardcoded HTML in `renderAgentsPanel()` | N/A - no endpoint needed |
| **Agent Types** | Renders from `workflowAgents` array | `GET /api/v1/agents?category=workflow` |
| **MCP Types** | Renders via `loadMCPTemplates()` | `GET /api/v1/mcp-templates` |
| **Node Creation** | `addStartNode()`, `addAgentNode()`, etc. | N/A - frontend only |
| **Saving Nodes** | Exports via `exportWorkflow()` | `POST/PUT /api/v1/workflows/{id}` |
| **Node Execution** | N/A - backend only | `GraphWorkflowRunner.php` |

---

## Appendix: Complete Node Output Formats

### Agent Node
```json
{
  "type": "agent",
  "agent_id": 123,
  "agent_name": "Research Assistant",
  "output": "LLM response text...",
  "success": true,
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 800,
    "total_tokens": 2300
  }
}
```

### Condition Node
```json
{
  "type": "condition",
  "condition": "contains:approved",
  "result": true,
  "branch": "true",
  "output": "Input text passed through..."
}
```

### Merge Node
```json
{
  "type": "merge",
  "inputs_count": 3,
  "input_sources": ["Agent A", "Agent B", "Agent C"],
  "output": "## Agent A\n\n...\n\n---\n\n## Agent B\n\n..."
}
```

### MCP Node
```json
{
  "type": "mcp",
  "success": true,
  "server_name": "Data Processor",
  "functions_count": 2,
  "output": "{\"results\": [...]}"
}
```

---

## Execution Paths: Conversation vs Workflow

This section documents the code execution paths from API endpoint to LLM providers for both regular conversations and workflow executions.

---

### Conversation Path

When a user sends a chat message, the request follows this path:

```
HTTP Request: POST /api/v1/chat
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. index.php                                                                │
│    Entry point - loads config, initializes middleware                       │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. src/Middleware/MiddlewareProcessor.php                                   │
│    CORS, authentication, request validation                                 │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. src/routes.php                                                           │
│    Route: POST /api/v1/chat → ChatController::chat()                        │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. src/Controllers/ChatController.php                                       │
│    - Extracts message, history, provider                                    │
│    - Routes to handleStreamingChat() or handleRegularChat()                 │
│    - Sets up SSE for streaming                                              │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. src/AIPortfolioAssistant.php                                             │
│    - Creates SSE client                                                     │
│    - Selects LLM provider                                                   │
│    - Merges base tools with MCP tools                                       │
│    - Calls LLMManager::streamChat()                                         │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. src/Services/LLMManager.php                                              │
│    - Resolves provider name                                                 │
│    - Normalizes conversation history                                        │
│    - Calls provider->streamChat()                                           │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. src/Providers/{Provider}Provider.php                                     │
│    ClaudeProvider, OpenAIProvider, GrokProvider, GeminiProvider, etc.       │
│    - Builds API request payload                                             │
│    - Makes HTTP request to LLM API                                          │
│    - Handles tool calls recursively                                         │
│    - Returns response with usage metrics                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Files involved (sequential order):**
1. `backend/index.php`
2. `backend/src/Middleware/MiddlewareProcessor.php`
3. `backend/src/routes.php`
4. `backend/src/Controllers/ChatController.php`
5. `backend/src/AIPortfolioAssistant.php`
6. `backend/src/Services/LLMManager.php`
7. `backend/src/Providers/ClaudeProvider.php` (or other provider)
8. `backend/src/Services/ToolsManager.php` (if tools are called)

---

### Workflow Path

When a workflow is executed, the request follows this path:

```
HTTP Request: POST /api/v1/workflows/{id}/run (or /run-stream)
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. index.php                                                                │
│    Entry point - loads config, initializes middleware                       │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. src/Middleware/MiddlewareProcessor.php                                   │
│    CORS, authentication, request validation                                 │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. src/routes.php                                                           │
│    Route: POST /api/v1/workflows/{id}/run → WorkflowController::run()       │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. src/AgentTeam/Controllers/WorkflowController.php                         │
│    - Validates workflow access                                              │
│    - Extracts input variables                                               │
│    - Determines workflow type (graph-based vs legacy)                       │
│    - Calls GraphWorkflowRunner::run()                                       │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. src/AgentTeam/Services/GraphWorkflowRunner.php                           │
│    - Creates execution record                                               │
│    - Finds Start node                                                       │
│    - BFS queue-based graph traversal                                        │
│    - Detects parallelism: multiple outgoing edges → executeAgentsInParallel │
│    - Dispatches to node handlers based on node_type:                        │
│      • agent    → executeAgentNode()                                        │
│      • merge    → executeMergeNode()                                        │
│      • condition/switch → evaluate and route                                │
│      • output   → collect final output                                      │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ├─── Single Agent ───┐
         │                    ▼
         │    ┌───────────────────────────────────────────────────────────────┐
         │    │ 6a. src/AgentTeam/Services/AgentRunner.php                    │
         │    │     - Loads agent configuration                               │
         │    │     - Gets LLM provider via LLMManager                        │
         │    │     - Builds tools and system prompt                          │
         │    │     - Calls provider->chat()                                  │
         │    └───────────────────────────────────────────────────────────────┘
         │
         └─── Parallel Agents ─┐
                               ▼
         ┌────────────────────────────────────────────────────────────────────┐
         │ 6b. GraphWorkflowRunner::executeAgentsInParallel()                 │
         │     - Initializes all parallel agents                              │
         │     - Uses curl_multi for true parallel HTTP requests              │
         │     - Each agent calls its provider independently                  │
         │     - Handles tool calls iteratively                               │
         └────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. src/Services/LLMManager.php                                              │
│    - Resolves provider                                                      │
│    - Returns provider instance                                              │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 8. src/Providers/{Provider}Provider.php                                     │
│    ClaudeProvider, OpenAIProvider, GrokProvider, GeminiProvider, etc.       │
│    - Builds API request payload                                             │
│    - Makes HTTP request to LLM API                                          │
│    - Handles tool calls                                                     │
│    - Returns response                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Files involved (sequential order):**
1. `backend/index.php`
2. `backend/src/Middleware/MiddlewareProcessor.php`
3. `backend/src/routes.php`
4. `backend/src/AgentTeam/Controllers/WorkflowController.php`
5. `backend/src/AgentTeam/Services/GraphWorkflowRunner.php`
6. `backend/src/AgentTeam/Services/AgentRunner.php`
7. `backend/src/Services/LLMManager.php`
8. `backend/src/Providers/ClaudeProvider.php` (or other provider)
9. `backend/src/AgentTeam/Services/WorkflowGraphRepository.php` (node/edge data)
10. `backend/src/AgentTeam/Services/WorkflowOutputStorage.php` (result storage)

---

### Key Differences: Conversation vs Workflow

| Aspect | Conversation | Workflow |
|--------|--------------|----------|
| Entry Controller | `ChatController` | `WorkflowController` |
| Orchestration | Direct LLM call | Graph traversal engine |
| Agent Management | Single implicit agent | Multiple explicit agents |
| Parallel Execution | N/A | `executeAgentsInParallel()` with `curl_multi` |
| State Management | Conversation history | Node outputs stored per execution |
| Tool Loading | `MCPToolsLoader` in ChatController | Per-agent tool configuration |

---

### Parallel Execution Flow

Parallel execution is **automatically inferred** from the graph structure. When a node has multiple outgoing edges connecting to agent nodes, those agents are executed in parallel.

**Simplified workflow (no Parallel node needed):**
```
Start → [Agent1, Agent2, Agent3] → Merge → Output
```

**How it works:**
1. After executing any node, the runner checks outgoing edges
2. If multiple edges connect to agent nodes, they are detected via `findAgentNodesInList()`
3. All detected agent nodes are executed simultaneously via `executeAgentsInParallel()`
4. Uses `curl_multi` for true parallel HTTP requests
5. Results are collected in the Merge node

**Key insight:** The number of outgoing connectors from a node determines execution mode:
- **Single connector** → Sequential execution
- **Multiple connectors to agents** → Parallel execution
