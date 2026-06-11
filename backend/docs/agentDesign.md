# AgentTeam System Design Document

## Overview

This document describes the design and implementation of a TeamAI-like multi-agent system for the PHP backend. The system enables creating, managing, and orchestrating AI agents that can use tools, delegate tasks to other agents, and work together on complex workflows.

**Namespace:** `AgentTeam`

**Inspired by:** [TeamAI](https://teamai.com/) - A collaborative AI platform for teams

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Schema](#2-database-schema)
3. [Directory Structure](#3-directory-structure)
4. [Agent Types](#4-agent-types)
5. [Core Classes](#5-core-classes)
6. [API Endpoints](#6-api-endpoints)
7. [Tools](#7-tools)
8. [Example Agents](#8-example-agents)
9. [Manager Agent Pattern](#9-manager-agent-pattern)
10. [Workflows](#10-workflows)
11. [Integration with Existing Backend](#11-integration-with-existing-backend)
12. [Request/Response Examples](#12-requestresponse-examples)
13. [Frontend Workflow UI](#13-frontend-workflow-ui)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         API Layer                                    │
├─────────────────────────────────┬───────────────────────────────────┤
│     REST JSON API               │         MCP JSON-RPC              │
│   /api/v1/agents/*              │      /api/v1/mcp/agents           │
└────────────────┬────────────────┴─────────────────┬─────────────────┘
                 │                                   │
                 └───────────────┬───────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      AgentTeam Services                              │
├─────────────────┬─────────────────┬─────────────────────────────────┤
│ AgentRepository │   AgentRunner   │   AgentDelegationFunctions      │
│  (CRUD + ACL)   │  (Execution)    │   (Manager → Worker calls)      │
└────────┬────────┴────────┬────────┴─────────────────────────────────┘
         │                 │
         │                 ▼
         │    ┌────────────────────────────────────────────────────────┐
         │    │         Existing Backend Services (Reused)             │
         │    ├────────────┬────────────┬────────────┬─────────────────┤
         │    │ LLMManager │ToolsManager│MCPTools    │  UsageLogger    │
         │    │ (7 provs)  │ (builtin)  │Loader      │  (billing)      │
         │    └────────────┴────────────┴────────────┴─────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Database                                      │
├─────────────────┬─────────────────┬─────────────────────────────────┤
│     agents      │ agent_executions│   agent_workflows               │
└─────────────────┴─────────────────┴─────────────────────────────────┘
```

### Key Design Principles

1. **Separation of Concerns**: AgentTeam namespace is separate from existing AIPortfolioAssistant
2. **Reuse**: Leverages existing LLM providers, tools, MCP integration, and usage tracking
3. **Dual API**: Supports both REST JSON and MCP JSON-RPC protocols
4. **Hierarchical Agents**: Manager agents can delegate to worker agents
5. **Tool-based**: Agents are configured with specific tools they can use

---

## 2. Database Schema

### 2.1 Agent Teams Table

```sql
CREATE TABLE agent_teams (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    workspace_id INT DEFAULT NULL,

    -- Identity
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user (user_id),
    INDEX idx_workspace (workspace_id)
);
```

### 2.2 Agents Table

```sql
CREATE TABLE agents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    workspace_id INT DEFAULT NULL,
    team_id INT DEFAULT NULL,

    -- Identity
    name VARCHAR(255) NOT NULL,
    description TEXT,
    avatar_url VARCHAR(500) DEFAULT NULL,

    -- Agent Type & Hierarchy
    agent_type ENUM('standard', 'manager', 'worker') DEFAULT 'standard',
    parent_agent_id INT DEFAULT NULL,
    can_delegate_to JSON DEFAULT NULL,           -- [1, 2, 3] agent IDs

    -- LLM Configuration
    provider VARCHAR(50) DEFAULT 'claude',       -- claude, openai, grok, gemini, etc.
    model VARCHAR(100) DEFAULT NULL,             -- NULL = use provider default
    instructions TEXT,                            -- System prompt

    -- Tools & Knowledge
    tools JSON,                                   -- ["get_portfolios", "serpapi_search"]
    knowledge_sources JSON,                       -- For future RAG integration

    -- Access Control
    visibility ENUM('personal', 'workspace', 'public') DEFAULT 'personal',
    enabled BOOLEAN DEFAULT TRUE,

    -- Settings
    settings JSON,                                -- {temperature, max_tokens, etc.}

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_user (user_id),
    INDEX idx_workspace (workspace_id),
    INDEX idx_team (team_id),
    INDEX idx_visibility (visibility),
    INDEX idx_type (agent_type),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES agent_teams(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);
```

### 2.3 Agent Executions Table

```sql
CREATE TABLE agent_executions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    parent_execution_id INT DEFAULT NULL,        -- For nested/delegated calls
    agent_id INT NOT NULL,
    user_id INT NOT NULL,

    -- Execution Data
    input TEXT,
    output TEXT,
    status ENUM('pending', 'running', 'completed', 'failed') DEFAULT 'pending',
    error_message TEXT DEFAULT NULL,

    -- Usage Tracking
    tokens_used INT DEFAULT 0,
    cost_usd DECIMAL(10, 6) DEFAULT 0,
    response_time_ms INT DEFAULT 0,
    tools_called JSON,                            -- ["tool1", "tool2"]

    -- Timestamps
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,

    -- Metadata
    metadata JSON,                                -- {delegation_depth, etc.}

    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_execution_id) REFERENCES agent_executions(id) ON DELETE SET NULL,
    INDEX idx_parent (parent_execution_id),
    INDEX idx_agent (agent_id),
    INDEX idx_user (user_id),
    INDEX idx_status (status)
);
```

### 2.4 Agent Conversations Table

```sql
CREATE TABLE agent_conversations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_id INT NOT NULL,
    user_id INT NOT NULL,
    context_id INT DEFAULT NULL,                  -- Link to existing conversation_contexts
    title VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (context_id) REFERENCES conversation_contexts(id) ON DELETE SET NULL
);
```

### 2.5 Agent Workflows Table

```sql
CREATE TABLE agent_workflows (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    workspace_id INT DEFAULT NULL,

    name VARCHAR(255) NOT NULL,
    description TEXT,
    steps JSON NOT NULL,                          -- Workflow definition
    triggers JSON,                                -- API, schedule, webhook
    variables JSON,                               -- Default variables for workflow

    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_user (user_id),
    INDEX idx_enabled (enabled)
);
```

### 2.6 Workflow Executions Table

```sql
CREATE TABLE agent_workflow_executions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    workflow_id INT NOT NULL,
    user_id INT NOT NULL,
    input_variables JSON,
    output JSON,
    status ENUM('pending', 'running', 'completed', 'failed') DEFAULT 'pending',
    error_message TEXT,
    response_time_ms INT DEFAULT 0,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,

    INDEX idx_workflow (workflow_id),
    INDEX idx_user (user_id),
    INDEX idx_status (status)
);
```

### 2.7 Extend Existing Usage Table

```sql
ALTER TABLE llm_usage_transactions
ADD COLUMN agent_id INT DEFAULT NULL AFTER user_id,
ADD COLUMN execution_id INT DEFAULT NULL,
ADD INDEX idx_agent (agent_id);
```

---

## 3. Directory Structure

```
backend/
├── src/
│   ├── AgentTeam/                           # NEW NAMESPACE
│   │   ├── Models/
│   │   │   ├── Agent.php                    # Agent data model
│   │   │   ├── Team.php                     # Team data model
│   │   │   └── Workflow.php                 # Workflow data model
│   │   ├── Services/
│   │   │   ├── AgentRepository.php          # Agent CRUD + access control
│   │   │   ├── AgentRunner.php              # Agent execution engine
│   │   │   ├── TeamRepository.php           # Team CRUD
│   │   │   ├── WorkflowRepository.php       # Workflow CRUD
│   │   │   └── WorkflowRunner.php           # Multi-step workflow execution
│   │   ├── Functions/
│   │   │   └── AgentDelegationFunctions.php # Delegation tools
│   │   └── Controllers/
│   │       ├── AgentController.php          # Agent REST API endpoints
│   │       ├── AgentMCPController.php       # MCP JSON-RPC endpoint
│   │       ├── TeamController.php           # Team REST API endpoints
│   │       └── WorkflowController.php       # Workflow REST API endpoints
│   ├── Providers/                           # Existing (reused)
│   ├── Services/                            # Existing (reused)
│   ├── Functions/                           # Existing (reused)
│   └── routes.php                           # + new agent/team/workflow routes
├── database/
│   └── migrations/
│       └── create_agents_tables.sql
├── docs/
│   └── agentDesign.md                       # This document
└── composer.json                            # Update autoload
```

### Composer Autoload

```json
{
  "autoload": {
    "psr-4": {
      "Quantis\\AIPortfolioAssistant\\": "src/",
      "AgentTeam\\": "src/AgentTeam/"
    }
  }
}
```

---

## 4. Agent Types

| Type | Description | Tools | Can Delegate |
|------|-------------|-------|--------------|
| `standard` | Single-purpose agent with specific tools | Domain tools | No |
| `manager` | Orchestrator that coordinates other agents | `delegate_to_agent`, `run_agents_parallel`, `list_available_agents` | Yes |
| `worker` | Specialist agent called by managers | Domain tools | No |

### Type Characteristics

**Standard Agent:**
- Used for simple, focused tasks
- Has access to a curated set of tools
- Cannot delegate to other agents
- Examples: Portfolio Advisor, Stock Research Analyst

**Manager Agent:**
- Orchestrates complex, multi-step tasks
- Can delegate work to worker agents
- Has delegation tools: `delegate_to_agent`, `run_agents_parallel`
- Synthesizes results from workers
- Examples: Marketing Campaign Director, Project Manager

**Worker Agent:**
- Specialist in a specific domain
- Called by manager agents
- Cannot delegate further
- Examples: Content Writer, SEO Optimizer, Market Research Analyst

---

## 5. Core Classes

### 5.1 Team Model

**File:** `src/AgentTeam/Models/Team.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Models;

class Team
{
    // Properties
    private ?int $id = null;
    private int $userId;
    private ?int $workspaceId = null;
    private string $name;
    private string $description = '';
    private ?string $createdAt = null;
    private ?string $updatedAt = null;

    // Related agents (loaded separately)
    private array $agents = [];

    // Key Methods
    public function __construct(array $data = []);
    public function hydrate(array $data): self;
    public function toArray(): array;
    public function toArrayWithAgents(): array;

    // Getters & Setters (fluent interface)
    public function getId(): ?int;
    public function getUserId(): int;
    public function setUserId(int $userId): self;
    public function getName(): string;
    public function setName(string $name): self;
    public function getDescription(): string;
    public function setDescription(string $description): self;
    public function getAgents(): array;
    public function setAgents(array $agents): self;
    // ... etc
}
```

### 5.2 Team Repository

**File:** `src/AgentTeam/Services/TeamRepository.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Team;
use PDO;

class TeamRepository
{
    private PDO $db;

    public function __construct(PDO $db);

    // CRUD Operations
    public function findById(int $id): ?Team;
    public function findByIdWithAgents(int $id): ?Team;
    public function findByUser(int $userId): array;
    public function create(Team $team): Team;
    public function update(Team $team): Team;
    public function delete(int $id): bool;

    // Access Control
    public function canUserAccess(int $userId, int $teamId): bool;
}
```

### 5.3 Team Controller

**File:** `src/AgentTeam/Controllers/TeamController.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Models\Team;
use AgentTeam\Services\TeamRepository;
use AgentTeam\Services\AgentRepository;

class TeamController
{
    private TeamRepository $teamRepository;
    private AgentRepository $agentRepository;

    public function __construct(TeamRepository $teamRepository, AgentRepository $agentRepository);

    // CRUD Endpoints
    public function index(array $request): array;      // GET /teams
    public function create(array $request): array;     // POST /teams
    public function show(array $request): array;       // GET /teams/{id}
    public function update(array $request): array;     // PUT /teams/{id}
    public function destroy(array $request): array;    // DELETE /teams/{id}
    public function agents(array $request): array;     // GET /teams/{id}/agents
}
```

### 5.4 Agent Model

**File:** `src/AgentTeam/Models/Agent.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Models;

class Agent
{
    // Properties
    private ?int $id = null;
    private int $userId;
    private ?int $workspaceId = null;
    private string $name;
    private string $description = '';
    private string $agentType = 'standard';
    private ?int $parentAgentId = null;
    private array $canDelegateTo = [];
    private string $provider = 'claude';
    private ?string $model = null;
    private string $instructions = '';
    private array $tools = [];
    private array $knowledgeSources = [];
    private string $visibility = 'personal';
    private array $settings = [];
    private ?string $avatarUrl = null;
    private bool $enabled = true;

    // Key Methods
    public function __construct(array $data = []);
    public function hydrate(array $data): self;
    public function toArray(): array;
    public function buildSystemPrompt(): string;
    public function isManager(): bool;
    public function isWorker(): bool;
    public function canDelegateToAgent(int $agentId): bool;

    // Getters & Setters (fluent interface)
    public function getId(): ?int;
    public function getName(): string;
    public function setName(string $name): self;
    // ... etc
}
```

### 5.5 Agent Repository

**File:** `src/AgentTeam/Services/AgentRepository.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Agent;
use PDO;

class AgentRepository
{
    private PDO $db;

    public function __construct(PDO $db);

    // CRUD Operations
    public function findById(int $id): ?Agent;
    public function findByName(string $name, int $userId): ?Agent;
    public function findAccessibleByUser(int $userId, array $filters = []): array;
    public function findWorkerAgents(int $managerId): array;
    public function create(Agent $agent): Agent;
    public function update(Agent $agent): Agent;
    public function delete(int $id): bool;

    // Access Control
    public function canUserAccess(int $userId, int $agentId): bool;
}
```

### 5.6 Agent Runner

**File:** `src/AgentTeam/Services/AgentRunner.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Agent;
use Quantis\AIPortfolioAssistant\Services\LLMManager;
use Quantis\AIPortfolioAssistant\Services\ToolsManager;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\CombinedToolsExecutor;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;
use PDO;

class AgentRunner
{
    // Dependencies
    private LLMManager $llmManager;
    private ToolsManager $toolsManager;
    private MCPToolsLoader $mcpToolsLoader;
    private UsageLogger $usageLogger;
    private PDO $db;
    private array $config;

    public function __construct(...);

    // Execution Methods
    public function run(
        Agent $agent,
        string $input,
        array $conversationHistory = [],
        int $userId = 0,
        array $context = []
    ): array;

    public function streamRun(
        Agent $agent,
        string $input,
        array $conversationHistory = [],
        int $userId = 0,
        callable $onChunk = null
    ): void;

    // Private Methods
    private function buildToolsForAgent(Agent $agent): array;
    private function createExecution(Agent $agent, int $userId, string $input, array $context): int;
    private function completeExecution(int $executionId, array $response, float $responseTime): void;
    private function failExecution(int $executionId, string $error): void;
}
```

### 5.7 Agent Delegation Functions

**File:** `src/AgentTeam/Functions/AgentDelegationFunctions.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Functions;

use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;

class AgentDelegationFunctions
{
    private AgentRepository $repository;
    private AgentRunner $runner;

    public function __construct(AgentRepository $repository, AgentRunner $runner);

    public function getAllFunctions(): array;

    // Tool Handlers
    public function delegateToAgent(array $params, int $userId, array $context = []): array;
    public function listAvailableAgents(array $params, int $userId, array $context = []): array;
    public function runAgentsParallel(array $params, int $userId, array $context = []): array;
}
```

### 5.5 Agent Controller

**File:** `src/AgentTeam/Controllers/AgentController.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Models\Agent;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;

class AgentController
{
    private AgentRepository $repository;
    private AgentRunner $runner;

    public function __construct(AgentRepository $repository, AgentRunner $runner);

    // CRUD Endpoints
    public function index(array $request): array;      // GET /agents
    public function create(array $request): array;     // POST /agents
    public function show(array $request): array;       // GET /agents/{id}
    public function update(array $request): array;     // PUT /agents/{id}
    public function destroy(array $request): array;    // DELETE /agents/{id}

    // Execution Endpoints
    public function run(array $request): array;        // POST /agents/{id}/run
    public function chat(array $request): void;        // POST /agents/{id}/chat (SSE)

    // Utility Endpoints
    public function listTools(array $request): array;  // GET /agents/tools
}
```

### 5.6 Agent MCP Controller

**File:** `src/AgentTeam/Controllers/AgentMCPController.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;

class AgentMCPController
{
    private AgentRepository $repository;
    private AgentRunner $runner;

    public function __construct(AgentRepository $repository, AgentRunner $runner);

    // MCP JSON-RPC Handler
    public function handle(array $request): array;

    // MCP Methods
    private function initialize(): array;
    private function listAgents(int $userId): array;
    private function getAgent(int $userId, array $params): array;
    private function createAgent(int $userId, array $params): array;
    private function updateAgent(int $userId, array $params): array;
    private function deleteAgent(int $userId, array $params): array;
    private function runAgent(int $userId, array $params): array;
    private function listTools(): array;
}
```

### 5.8 Workflow Model

**File:** `src/AgentTeam/Models/Workflow.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Models;

class Workflow
{
    // Properties
    private ?int $id = null;
    private int $userId;
    private ?int $workspaceId = null;
    private string $name;
    private string $description = '';
    private array $steps = [];
    private array $triggers = [];
    private array $variables = [];
    private bool $enabled = true;

    // Key Methods
    public function __construct(array $data = []);
    public function hydrate(array $data): self;
    public function toArray(): array;
    public function toApiArray(): array;
    public function validateSteps(): array;
    public function getStep(string $stepId): ?array;
    public function getEntrySteps(): array;
    public function interpolateVariables(string $template, array $context = []): string;

    // Getters & Setters (fluent interface)
    // ...
}
```

### 5.9 Workflow Repository

**File:** `src/AgentTeam/Services/WorkflowRepository.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Workflow;
use PDO;

class WorkflowRepository
{
    private PDO $db;

    public function __construct(PDO $db);

    // CRUD Operations
    public function findById(int $id): ?Workflow;
    public function findByUser(int $userId): array;
    public function findEnabledByUser(int $userId): array;
    public function create(Workflow $workflow): Workflow;
    public function update(Workflow $workflow): Workflow;
    public function delete(int $id): bool;

    // Access Control
    public function canUserAccess(int $userId, int $workflowId): bool;
    public function isOwner(int $userId, int $workflowId): bool;

    // Utility
    public function toggleEnabled(int $id): bool;
    public function duplicate(int $workflowId, int $newUserId, ?string $newName = null): ?Workflow;
}
```

### 5.10 Workflow Runner

**File:** `src/AgentTeam/Services/WorkflowRunner.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Workflow;
use PDO;

class WorkflowRunner
{
    private PDO $db;
    private AgentRepository $agentRepository;
    private AgentRunner $agentRunner;

    public function __construct(PDO $db, AgentRepository $agentRepository, AgentRunner $agentRunner, array $config = []);

    // Main execution
    public function run(Workflow $workflow, int $userId, array $inputVariables = []): array;

    // Step executors (private)
    private function executeStep(array $step, Workflow $workflow, int $userId, array $variables): mixed;
    private function executeAgentStep(array $step, Workflow $workflow, int $userId, array $variables): array;
    private function executeParallelStep(array $step, Workflow $workflow, int $userId, array $variables): array;
    private function executeConditionStep(array $step, Workflow $workflow, int $userId, array $variables): array;
    private function executeTransformStep(array $step, array $variables): array;

    // Execution tracking
    public function getExecutionHistory(int $workflowId, int $limit = 50, int $offset = 0): array;
}
```

### 5.11 Workflow Controller

**File:** `src/AgentTeam/Controllers/WorkflowController.php`

```php
<?php
declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\WorkflowRepository;
use AgentTeam\Services\WorkflowRunner;
use PDO;

class WorkflowController
{
    private PDO $db;
    private array $config;
    private WorkflowRepository $workflowRepository;
    private WorkflowRunner $workflowRunner;

    public function __construct(PDO $db, array $config);

    // CRUD Endpoints
    public function index(array $request): array;      // GET /workflows
    public function create(array $request): array;     // POST /workflows
    public function show(array $request): array;       // GET /workflows/{id}
    public function update(array $request): array;     // PUT /workflows/{id}
    public function destroy(array $request): array;    // DELETE /workflows/{id}

    // Execution Endpoints
    public function run(array $request): array;        // POST /workflows/{id}/run
    public function executions(array $request): array; // GET /workflows/{id}/executions

    // Utility Endpoints
    public function toggle(array $request): array;     // POST /workflows/{id}/toggle
    public function duplicate(array $request): array;  // POST /workflows/{id}/duplicate
}
```

---

## 6. API Endpoints

### 6.1 REST JSON API

#### Team Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/teams` | List user's teams |
| `POST` | `/api/v1/teams` | Create team |
| `GET` | `/api/v1/teams/{id}` | Get team details (with agents) |
| `PUT` | `/api/v1/teams/{id}` | Update team |
| `DELETE` | `/api/v1/teams/{id}` | Delete team |
| `GET` | `/api/v1/teams/{id}/agents` | List agents in team |

#### Agent Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/agents` | List accessible agents |
| `POST` | `/api/v1/agents` | Create agent |
| `GET` | `/api/v1/agents/tools` | List available tools |
| `GET` | `/api/v1/agents/{id}` | Get agent details |
| `PUT` | `/api/v1/agents/{id}` | Update agent |
| `DELETE` | `/api/v1/agents/{id}` | Delete agent |
| `POST` | `/api/v1/agents/{id}/run` | Execute agent (non-streaming) |
| `POST` | `/api/v1/agents/{id}/chat` | Execute agent (SSE streaming) |
| `GET` | `/api/v1/agents/{id}/executions` | Get execution history |

#### Workflow Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/workflows` | List user's workflows |
| `POST` | `/api/v1/workflows` | Create workflow |
| `GET` | `/api/v1/workflows/{id}` | Get workflow details |
| `PUT` | `/api/v1/workflows/{id}` | Update workflow |
| `DELETE` | `/api/v1/workflows/{id}` | Delete workflow |
| `POST` | `/api/v1/workflows/{id}/run` | Execute workflow |
| `GET` | `/api/v1/workflows/{id}/executions` | Get execution history |
| `POST` | `/api/v1/workflows/{id}/toggle` | Toggle enabled/disabled |
| `POST` | `/api/v1/workflows/{id}/duplicate` | Duplicate workflow |

### 6.2 MCP JSON-RPC API

**Endpoint:** `POST /api/v1/mcp/agents`

| Method | Description |
|--------|-------------|
| `initialize` | Handshake, return capabilities |
| `agents/list` | List agents |
| `agents/create` | Create agent |
| `agents/get` | Get agent by ID |
| `agents/update` | Update agent |
| `agents/delete` | Delete agent |
| `agents/run` | Execute agent |
| `tools/list` | List available tools |
| `tools/call` | Execute a tool directly |

### 6.3 Routes Definition

```php
<?php
// Add to backend/src/routes.php

use AgentTeam\Controllers\TeamController;
use AgentTeam\Controllers\AgentController;
use AgentTeam\Controllers\AgentMCPController;
use AgentTeam\Controllers\WorkflowController;

// Team CRUD
$r->addRoute('GET', '/api/v1/teams', [TeamController::class, 'index']);
$r->addRoute('POST', '/api/v1/teams', [TeamController::class, 'create']);
$r->addRoute('GET', '/api/v1/teams/{id:\d+}', [TeamController::class, 'show']);
$r->addRoute('PUT', '/api/v1/teams/{id:\d+}', [TeamController::class, 'update']);
$r->addRoute('DELETE', '/api/v1/teams/{id:\d+}', [TeamController::class, 'destroy']);
$r->addRoute('GET', '/api/v1/teams/{id:\d+}/agents', [TeamController::class, 'agents']);

// Workflow CRUD
$r->addRoute('GET', '/api/v1/workflows', [WorkflowController::class, 'index']);
$r->addRoute('POST', '/api/v1/workflows', [WorkflowController::class, 'create']);
$r->addRoute('GET', '/api/v1/workflows/{id:\d+}', [WorkflowController::class, 'show']);
$r->addRoute('PUT', '/api/v1/workflows/{id:\d+}', [WorkflowController::class, 'update']);
$r->addRoute('DELETE', '/api/v1/workflows/{id:\d+}', [WorkflowController::class, 'destroy']);
$r->addRoute('POST', '/api/v1/workflows/{id:\d+}/run', [WorkflowController::class, 'run']);
$r->addRoute('GET', '/api/v1/workflows/{id:\d+}/executions', [WorkflowController::class, 'executions']);
$r->addRoute('POST', '/api/v1/workflows/{id:\d+}/toggle', [WorkflowController::class, 'toggle']);
$r->addRoute('POST', '/api/v1/workflows/{id:\d+}/duplicate', [WorkflowController::class, 'duplicate']);

// Agent CRUD
$r->addRoute('GET', '/api/v1/agents', [AgentController::class, 'index']);
$r->addRoute('POST', '/api/v1/agents', [AgentController::class, 'create']);
$r->addRoute('GET', '/api/v1/agents/tools', [AgentController::class, 'listTools']);
$r->addRoute('GET', '/api/v1/agents/{id:\d+}', [AgentController::class, 'show']);
$r->addRoute('PUT', '/api/v1/agents/{id:\d+}', [AgentController::class, 'update']);
$r->addRoute('DELETE', '/api/v1/agents/{id:\d+}', [AgentController::class, 'destroy']);

// Agent Execution
$r->addRoute('POST', '/api/v1/agents/{id:\d+}/run', [AgentController::class, 'run']);
$r->addRoute('POST', '/api/v1/agents/{id:\d+}/chat', [AgentController::class, 'chat']);

// MCP JSON-RPC
$r->addRoute('POST', '/api/v1/mcp/agents', [AgentMCPController::class, 'handle']);
```

---

## 7. Tools

### 7.1 Existing Tools (Reused from Backend)

| Category | Tools |
|----------|-------|
| **Portfolio** | `get_portfolios`, `get_portfolio_assets_with_discovery`, `get_portfolio_diversification`, `get_all_transactions` |
| **Watchlist** | `get_user_watchlist`, `get_watchlist_with_market_data`, `add_to_watchlist`, `remove_from_watchlist` |
| **Market Data** | `search_assets`, `get_trending_assets`, `get_top_gainers`, `get_top_losers` |
| **Analysis** | `get_analyst_ratings`, `get_financial_ratios`, `get_price_targets`, `get_company_profile`, `get_asset_sentiment` |
| **Crypto News** | `llm_get_crypto_news`, `llm_get_priority_crypto_news`, `llm_get_news_by_source` |
| **Financial News** | `get_financial_news`, `list_financial_news_sources` |
| **Web Search** | `serpapi_search`, `brave_search` |
| **Medical** | `pubmed_search`, `pubmed_build_query`, `pubmed_mesh_suggestions` |
| **MCP Tools** | Any tools from registered MCP servers (prefixed with `mcp_`) |

### 7.2 New Delegation Tools (For Manager Agents)

#### delegate_to_agent

```json
{
  "name": "delegate_to_agent",
  "description": "Delegate a task to a specialized sub-agent. The sub-agent will execute and return results.",
  "input_schema": {
    "type": "object",
    "properties": {
      "agent_id": {
        "type": "integer",
        "description": "ID of the agent to delegate to"
      },
      "agent_name": {
        "type": "string",
        "description": "Name of the agent (alternative to agent_id)"
      },
      "task": {
        "type": "string",
        "description": "The task description for the sub-agent"
      },
      "context": {
        "type": "string",
        "description": "Additional context from previous outputs"
      }
    },
    "required": ["task"]
  }
}
```

#### list_available_agents

```json
{
  "name": "list_available_agents",
  "description": "List agents that this manager can delegate tasks to",
  "input_schema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

#### run_agents_parallel

```json
{
  "name": "run_agents_parallel",
  "description": "Run multiple agents in parallel and collect results",
  "input_schema": {
    "type": "object",
    "properties": {
      "delegations": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "agent_name": {"type": "string"},
            "task": {"type": "string"}
          }
        },
        "description": "Array of {agent_name, task} to run in parallel"
      }
    },
    "required": ["delegations"]
  }
}
```

---

## 8. Example Agents

### 8.1 Standard Agents

#### Portfolio Advisor

```json
{
  "name": "Portfolio Advisor",
  "description": "Expert financial advisor that analyzes investment portfolios and provides diversification insights.",
  "agent_type": "standard",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are a professional portfolio advisor. When analyzing portfolios:\n\n1. Start by fetching holdings using get_portfolio_assets_with_discovery\n2. Analyze diversification using get_portfolio_diversification\n3. For stocks, get detailed analysis with get_analyst_ratings and get_financial_ratios\n4. Provide actionable insights with specific numbers and percentages",
  "tools": [
    "get_portfolios",
    "get_portfolio_assets_with_discovery",
    "get_portfolio_diversification",
    "get_all_transactions",
    "get_analyst_ratings",
    "get_financial_ratios",
    "get_price_targets",
    "get_company_profile"
  ],
  "visibility": "public",
  "settings": {
    "temperature": 0.3,
    "max_tokens": 4096
  }
}
```

#### Crypto News Analyst

```json
{
  "name": "Crypto News Analyst",
  "description": "Real-time cryptocurrency news analyst monitoring 14+ crypto news sources.",
  "agent_type": "standard",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are a crypto market analyst specializing in news-driven trading insights.\n\nYour workflow:\n1. Use llm_get_crypto_news with topic filtering for specific coins\n2. Use llm_get_priority_crypto_news for breaking news\n3. Cross-reference with get_asset_sentiment\n4. Check user's watchlist impact using get_watchlist_with_market_data\n\nFormat: Headlines, Market Impact, Trading Implications, Risk Factors",
  "tools": [
    "llm_get_crypto_news",
    "llm_get_priority_crypto_news",
    "llm_get_news_by_source",
    "get_asset_sentiment",
    "get_watchlist_with_market_data",
    "get_trending_assets"
  ],
  "visibility": "public",
  "settings": {
    "temperature": 0.5
  }
}
```

#### Medical Research Assistant

```json
{
  "name": "Medical Research Assistant",
  "description": "Biomedical research assistant for PubMed literature search and analysis.",
  "agent_type": "standard",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are a medical research librarian assistant.\n\n1. Use pubmed_mesh_suggestions to find proper MeSH terminology\n2. Use pubmed_build_query for complex queries\n3. Execute searches with pubmed_search\n4. Summarize findings, note study types, cite PMIDs\n\nIMPORTANT: Provide research summaries, NOT medical advice.",
  "tools": [
    "pubmed_search",
    "pubmed_build_query",
    "pubmed_mesh_suggestions"
  ],
  "visibility": "public",
  "settings": {
    "temperature": 0.2
  }
}
```

### 8.2 Manager + Worker Team (Marketing)

#### Manager: Marketing Campaign Director

```json
{
  "name": "Marketing Campaign Director",
  "description": "Senior marketing strategist that orchestrates comprehensive marketing campaigns by coordinating specialized agents.",
  "agent_type": "manager",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are a Marketing Campaign Director.\n\n## Your Team\n1. Market Research Agent - market trends, audience demographics\n2. Content Writer Agent - compelling copy, blog posts, emails\n3. Social Media Strategist - social campaigns, hashtags, schedules\n4. SEO Optimizer Agent - search optimization, keywords\n5. Competitor Analyst Agent - competitor strategies\n6. Analytics Agent - campaign data interpretation\n\n## Workflow\n1. Discovery: Run Market Research + Competitor Analyst in parallel\n2. Strategy: Synthesize findings, define messaging\n3. Content: Delegate to Content Writer, SEO Optimizer, Social Media\n4. Synthesis: Compile cohesive campaign plan\n\n## Output Format\n- Executive Summary\n- Campaign Strategy\n- Content Calendar\n- Channel-specific tactics\n- KPIs and success metrics\n- Budget recommendations",
  "tools": [
    "delegate_to_agent",
    "run_agents_parallel",
    "list_available_agents",
    "serpapi_search"
  ],
  "can_delegate_to": [1, 2, 3, 4, 5, 6],
  "visibility": "workspace",
  "settings": {
    "temperature": 0.4,
    "max_tokens": 8192
  }
}
```

#### Worker: Market Research Agent

```json
{
  "id": 1,
  "name": "Market Research Agent",
  "description": "Specializes in market analysis, audience research, and trend identification.",
  "agent_type": "worker",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are a Market Research Analyst.\n\n1. Use web search for current market data and trends\n2. Identify target audience demographics and psychographics\n3. Analyze market size and growth potential\n\n## Output Format\n- Market Overview (size, growth, key players)\n- Target Audience Profile\n- Trend Analysis\n- Key Insights",
  "tools": [
    "serpapi_search",
    "brave_search",
    "get_financial_news"
  ],
  "visibility": "workspace",
  "settings": {
    "temperature": 0.3
  }
}
```

#### Worker: Content Writer Agent

```json
{
  "id": 2,
  "name": "Content Writer Agent",
  "description": "Expert copywriter creating compelling marketing content.",
  "agent_type": "worker",
  "provider": "openai",
  "model": "gpt-4o",
  "instructions": "You are a Senior Copywriter.\n\n## Capabilities\n- Blog posts, email sequences, ad copy, landing pages\n\n## Writing Principles\n1. Lead with benefits\n2. Use power words\n3. Clear CTAs\n4. Match tone to audience\n\n## Output Format\n- Headline options (3 variations)\n- Body copy\n- CTA options\n- Suggested imagery",
  "tools": [
    "serpapi_search"
  ],
  "visibility": "workspace",
  "settings": {
    "temperature": 0.7
  }
}
```

#### Worker: Social Media Strategist

```json
{
  "id": 3,
  "name": "Social Media Strategist",
  "description": "Plans and optimizes social media campaigns across platforms.",
  "agent_type": "worker",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are a Social Media Strategist.\n\n## Platform Expertise\n- Instagram, LinkedIn, Twitter/X, TikTok, Facebook\n\n## Deliverables\n1. Platform Selection & Rationale\n2. Content Pillars (3-5 themes)\n3. Posting Schedule\n4. Hashtag Strategy\n5. Engagement Tactics",
  "tools": [
    "serpapi_search"
  ],
  "visibility": "workspace",
  "settings": {
    "temperature": 0.6
  }
}
```

#### Worker: SEO Optimizer Agent

```json
{
  "id": 4,
  "name": "SEO Optimizer Agent",
  "description": "Optimizes content for search engines with keyword research.",
  "agent_type": "worker",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are an SEO Specialist.\n\n## Tasks\n1. Keyword Research (primary, secondary, long-tail)\n2. On-Page Optimization (title, meta, headers)\n3. Content Structure\n\n## Output Format\n- Keyword Report\n- Optimized Title & Meta\n- Content Outline\n- SEO Checklist",
  "tools": [
    "serpapi_search",
    "brave_search"
  ],
  "visibility": "workspace",
  "settings": {
    "temperature": 0.2
  }
}
```

#### Worker: Competitor Analyst Agent

```json
{
  "id": 5,
  "name": "Competitor Analyst Agent",
  "description": "Performs deep competitive analysis including positioning and strategies.",
  "agent_type": "worker",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are a Competitive Intelligence Analyst.\n\n## Analysis Framework\n1. Competitor Identification\n2. Positioning Analysis\n3. Marketing Tactics\n4. SWOT per Competitor\n\n## Output Format\n- Competitor Overview Table\n- Positioning Map\n- Gap Analysis\n- Tactical Recommendations",
  "tools": [
    "serpapi_search",
    "brave_search",
    "get_company_profile"
  ],
  "visibility": "workspace",
  "settings": {
    "temperature": 0.3
  }
}
```

#### Worker: Analytics Agent

```json
{
  "id": 6,
  "name": "Analytics Agent",
  "description": "Interprets campaign performance data and provides optimization recommendations.",
  "agent_type": "worker",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are a Marketing Analytics Specialist.\n\n## Capabilities\n1. KPI Definition & Tracking\n2. Performance Analysis\n3. A/B Test Interpretation\n4. ROI Calculation\n\n## Output Format\n- Executive Summary\n- Key Metrics Dashboard\n- Trend Analysis\n- Prioritized Recommendations",
  "tools": [
    "serpapi_search"
  ],
  "visibility": "workspace",
  "settings": {
    "temperature": 0.2
  }
}
```

---

## 9. Manager Agent Pattern

### 9.1 Architecture

```
                    ┌─────────────────────────┐
                    │  Marketing Campaign     │
                    │     Manager Agent       │
                    │  (Orchestrator)         │
                    └───────────┬─────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
          ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  Market Research│   │  Content Writer │   │  Social Media   │
│     Agent       │   │     Agent       │   │   Strategist    │
└─────────────────┘   └─────────────────┘   └─────────────────┘
          │                     │                     │
          ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  Competitor     │   │  SEO Optimizer  │   │  Analytics      │
│  Analyst        │   │     Agent       │   │   Agent         │
└─────────────────┘   └─────────────────┘   └─────────────────┘
```

### 9.2 Delegation Flow

1. User sends request to Manager Agent
2. Manager breaks down task
3. Manager calls `list_available_agents` to see team
4. Manager calls `run_agents_parallel` for independent tasks
5. Manager calls `delegate_to_agent` for sequential tasks
6. Manager synthesizes results
7. Manager returns comprehensive response

### 9.3 Execution Tracking

Each delegation creates a linked execution record:

```
Execution #100 (Manager)
├── Execution #101 (Market Research Agent) - parent_execution_id: 100
├── Execution #102 (Competitor Analyst Agent) - parent_execution_id: 100
├── Execution #103 (Content Writer Agent) - parent_execution_id: 100
└── Execution #104 (SEO Optimizer Agent) - parent_execution_id: 100
```

---

## 10. Workflows

### 10.1 Workflow Definition Schema

```json
{
  "name": "Marketing Campaign Workflow",
  "description": "Automated multi-agent workflow for campaign creation",
  "steps": [
    {
      "id": "research",
      "type": "parallel",
      "agents": [
        {
          "agent": "Market Research Agent",
          "task_template": "Research market for: {{product_description}}, target: {{target_audience}}"
        },
        {
          "agent": "Competitor Analyst Agent",
          "task_template": "Analyze competitors in: {{industry}}"
        }
      ],
      "output_key": "research_phase"
    },
    {
      "id": "strategy",
      "type": "agent",
      "agent": "Marketing Campaign Director",
      "task_template": "Define campaign strategy based on: {{research_phase}}",
      "depends_on": ["research"],
      "output_key": "strategy"
    },
    {
      "id": "content",
      "type": "parallel",
      "depends_on": ["strategy"],
      "agents": [
        {
          "agent": "Content Writer Agent",
          "task_template": "Create content based on: {{strategy}}"
        },
        {
          "agent": "Social Media Strategist",
          "task_template": "Plan social campaign based on: {{strategy}}"
        }
      ],
      "output_key": "content_phase"
    },
    {
      "id": "optimize",
      "type": "agent",
      "agent": "SEO Optimizer Agent",
      "task_template": "Optimize content: {{content_phase}}",
      "depends_on": ["content"],
      "output_key": "optimized_content"
    },
    {
      "id": "finalize",
      "type": "agent",
      "agent": "Marketing Campaign Director",
      "task_template": "Compile final plan from all phases",
      "depends_on": ["optimize"],
      "output_key": "final_plan"
    }
  ],
  "triggers": [
    {
      "type": "api",
      "endpoint": "/api/v1/workflows/marketing-campaign/run"
    }
  ]
}
```

### 10.2 Step Types

| Type | Description |
|------|-------------|
| `agent` | Execute single agent |
| `parallel` | Execute multiple agents simultaneously |
| `condition` | Conditional branching |
| `transform` | Data transformation between steps |

---

## 11. Integration with Existing Backend

### 11.1 Reused Components

| Component | From Namespace | Used For |
|-----------|----------------|----------|
| `LLMManager` | `Quantis\AIPortfolioAssistant\Services` | Multi-provider LLM access |
| `ToolsManager` | `Quantis\AIPortfolioAssistant\Services` | Built-in tool definitions |
| `MCPToolsLoader` | `Quantis\AIPortfolioAssistant\Services` | MCP tool loading |
| `CombinedToolsExecutor` | `Quantis\AIPortfolioAssistant\Services` | Tool execution routing |
| `UsageLogger` | `Quantis\AIPortfolioAssistant\Services` | Usage tracking & billing |
| `AuthMiddleware` | `Quantis\AIPortfolioAssistant\Middleware` | JWT authentication |
| FastRoute | Existing router | HTTP routing |
| PDO | Database | Data persistence |

### 11.2 Supported LLM Providers

All 7 existing providers work with agents:

1. Claude (Anthropic)
2. OpenAI (GPT-4, GPT-4o)
3. Grok (xAI)
4. Gemini (Google)
5. DeepSeek
6. Kimi (Moonshot)
7. Custom OpenAI-compatible

### 11.3 Tool Registration

Delegation tools are registered with `ToolsManager` like other functions:

```php
$delegationFunctions = new AgentDelegationFunctions($repository, $runner);
$toolsManager->registerFunctions($delegationFunctions->getAllFunctions());
```

---

## 12. Request/Response Examples

### 12.1 Create Agent

**Request:**
```http
POST /api/v1/agents
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "name": "Portfolio Advisor",
  "description": "Analyzes investment portfolios",
  "agent_type": "standard",
  "provider": "claude",
  "model": "claude-sonnet-4-5-20250514",
  "instructions": "You are a professional portfolio advisor...",
  "tools": ["get_portfolios", "get_portfolio_assets_with_discovery"],
  "visibility": "personal",
  "settings": {
    "temperature": 0.3
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "user_id": 123,
    "name": "Portfolio Advisor",
    "description": "Analyzes investment portfolios",
    "agent_type": "standard",
    "provider": "claude",
    "model": "claude-sonnet-4-5-20250514",
    "tools": ["get_portfolios", "get_portfolio_assets_with_discovery"],
    "visibility": "personal",
    "enabled": true,
    "created_at": "2026-03-19T10:30:00Z"
  }
}
```

### 12.2 Create Manager Agent

**Request:**
```http
POST /api/v1/agents
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "name": "Marketing Campaign Director",
  "description": "Orchestrates marketing campaigns",
  "agent_type": "manager",
  "provider": "claude",
  "instructions": "You are a Marketing Campaign Director...",
  "tools": ["delegate_to_agent", "run_agents_parallel", "list_available_agents"],
  "can_delegate_to": [1, 2, 3, 4, 5, 6],
  "visibility": "workspace"
}
```

### 12.3 Run Agent

**Request:**
```http
POST /api/v1/agents/1/run
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "input": "Analyze my portfolio and suggest rebalancing"
}
```

**Response:**
```json
{
  "success": true,
  "text": "## Portfolio Analysis\n\nBased on your current holdings...",
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 2800
  },
  "tools_used": [
    {"name": "get_portfolio_assets_with_discovery", "success": true},
    {"name": "get_portfolio_diversification", "success": true}
  ],
  "execution_id": 456,
  "agent": {
    "id": 1,
    "name": "Portfolio Advisor",
    "type": "standard"
  }
}
```

### 12.4 Run Manager Agent (with Delegation)

**Request:**
```http
POST /api/v1/agents/7/run
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "input": "Create a Q2 marketing campaign for our B2B SaaS targeting CTOs. Budget: $100,000"
}
```

**Response:**
```json
{
  "success": true,
  "text": "## Q2 Marketing Campaign Plan\n\n### Executive Summary\n...",
  "usage": {
    "input_tokens": 3500,
    "output_tokens": 8200
  },
  "tools_used": [
    {"name": "run_agents_parallel", "success": true},
    {"name": "delegate_to_agent", "success": true},
    {"name": "delegate_to_agent", "success": true}
  ],
  "execution_id": 500,
  "agent": {
    "id": 7,
    "name": "Marketing Campaign Director",
    "type": "manager"
  },
  "delegations": [
    {"agent": "Market Research Agent", "execution_id": 501},
    {"agent": "Competitor Analyst Agent", "execution_id": 502},
    {"agent": "Content Writer Agent", "execution_id": 503},
    {"agent": "SEO Optimizer Agent", "execution_id": 504}
  ]
}
```

### 12.5 MCP JSON-RPC

**Request:**
```http
POST /api/v1/mcp/agents
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "agents/list",
  "params": {}
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "agents": [
      {
        "id": 1,
        "name": "Portfolio Advisor",
        "description": "Analyzes investment portfolios",
        "provider": "claude",
        "visibility": "personal"
      },
      {
        "id": 7,
        "name": "Marketing Campaign Director",
        "description": "Orchestrates marketing campaigns",
        "provider": "claude",
        "visibility": "workspace"
      }
    ]
  }
}
```

### 12.6 Streaming Response (SSE)

**Request:**
```http
POST /api/v1/agents/1/chat
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "input": "What are my top holdings?"
}
```

**Response (SSE Stream):**
```
data: {"type":"chunk","text":"Based on","agent_id":1}

data: {"type":"chunk","text":" your portfolio","agent_id":1}

data: {"type":"chunk","text":", your top holdings are:","agent_id":1}

data: {"type":"chunk","text":"\n\n1. **NVDA**","agent_id":1}

data: [DONE]
```

---

## 13. Frontend Workflow UI

### 13.1 Overview

The frontend workflow UI is integrated into the Agent Teams Panel (`agent-teams-panel.js`) and allows users to:

- Create one workflow per team
- Visually order agents using drag-and-drop
- Enable/disable workflow execution
- Run workflows with custom input
- Automatically sync workflow with team agents

### 13.2 HTML Structure

The workflow section is added to the team editor in `index.html`:

```html
<div id="team-workflow-section">
    <!-- Create Workflow Button (shown when no workflow exists) -->
    <div id="workflow-empty">
        <button id="create-workflow-btn">Create Workflow</button>
    </div>

    <!-- Workflow Editor (shown when workflow exists) -->
    <div id="workflow-editor" class="hidden">
        <!-- Draggable agent steps -->
        <div id="workflow-steps">
            <!-- Steps rendered dynamically -->
        </div>

        <!-- Controls -->
        <div>
            <input type="checkbox" id="workflow-enabled">
            <button id="run-workflow-btn">Run Workflow</button>
            <button id="save-workflow-btn">Save</button>
            <button id="delete-workflow-btn">Delete</button>
        </div>
    </div>
</div>
```

### 13.3 JavaScript Implementation

Key methods in `AgentTeamsPanel` class:

| Method | Description |
|--------|-------------|
| `loadTeamWorkflow(teamId)` | Fetch workflow from backend API |
| `createWorkflow()` | Create new workflow with team's agents |
| `saveWorkflow()` | Save reordered steps to backend |
| `deleteWorkflow()` | Delete workflow after confirmation |
| `runWorkflow()` | Execute workflow with user input |
| `renderWorkflow()` | Render workflow UI (empty state or editor) |
| `renderWorkflowSteps()` | Render draggable agent boxes |
| `setupWorkflowDragDrop()` | Initialize drag-and-drop handlers |
| `syncWorkflowWithTeamAgents()` | Sync workflow when agents change |

### 13.4 Drag-and-Drop Behavior

1. Each agent step is rendered as a draggable card with:
   - Step number (1, 2, 3...)
   - Agent type icon
   - Agent name
   - Drag handle

2. Drag events:
   - `dragstart`: Mark element as being dragged
   - `dragover`: Show drop indicator (top/bottom border)
   - `drop`: Reorder elements and update step numbers
   - `dragend`: Clean up visual states

3. After reorder:
   - Step numbers update automatically
   - Workflow marked as "dirty" until saved
   - Save button persists new order to backend

### 13.5 Workflow Sync Logic

When agents are added/removed from a team:

```javascript
async syncWorkflowWithTeamAgents() {
    // 1. Get current team agents and workflow steps
    // 2. Identify added agents (in team but not in workflow)
    // 3. Identify removed agents (in workflow but not in team)
    // 4. Update workflow steps:
    //    - Remove deleted agents
    //    - Add new agents at the end
    //    - Re-index step IDs and dependencies
    // 5. Save updated workflow to backend
}
```

### 13.6 Workflow Step Schema (Frontend → Backend)

When saving workflow from frontend:

```json
{
  "steps": [
    {
      "id": "step_1",
      "type": "agent",
      "agent_id": 1,
      "agent": "Research Agent",
      "task_template": "{{input}}",
      "output_key": "agent_1_output",
      "depends_on": []
    },
    {
      "id": "step_2",
      "type": "agent",
      "agent_id": 2,
      "agent": "Writer Agent",
      "task_template": "{{input}}",
      "output_key": "agent_2_output",
      "depends_on": ["step_1"]
    }
  ],
  "enabled": true,
  "variables": {
    "team_id": 123,
    "input": ""
  }
}
```

### 13.7 User Flow

1. **Create Workflow:**
   - User clicks "Create Workflow" button
   - System creates workflow with all team agents in current order
   - Workflow editor appears with draggable steps

2. **Reorder Agents:**
   - User drags agent card up/down
   - Step numbers update automatically
   - User clicks "Save" to persist order

3. **Run Workflow:**
   - User clicks "Run Workflow"
   - System prompts for input
   - Workflow executes agents in order (top → bottom)
   - Results displayed in alert

4. **Sync with Team Changes:**
   - When agent added to team: automatically added to workflow (at end)
   - When agent removed from team: automatically removed from workflow
   - Order preserved for existing agents

---

## Summary

This design document describes a comprehensive multi-agent system with:

| Feature | Description |
|---------|-------------|
| **Namespace** | `AgentTeam` (separate from existing backend) |
| **Agent Types** | Standard, Manager, Worker |
| **APIs** | REST JSON + MCP JSON-RPC |
| **LLM Support** | All 7 existing providers |
| **Tools** | 50+ existing tools + 3 delegation tools |
| **Orchestration** | Manager agents delegate to workers |
| **Workflows** | JSON-defined multi-step automation |
| **Frontend UI** | Drag-and-drop workflow editor with auto-sync |
| **Tracking** | Full execution history with delegation chains |
| **Access Control** | Personal, workspace, public visibility |

The system extends the existing backend with minimal changes while providing TeamAI-compatible functionality for building sophisticated agent teams.
