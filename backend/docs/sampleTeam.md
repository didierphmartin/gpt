# Sample Agent Team Structure

This document shows a complete example of an agent team with a manager and workers. The manager dynamically orchestrates workers using delegation tools - no workflow needed.

## Team

```json
{
  "id": 1,
  "user_id": 1,
  "name": "Content Creation Team",
  "description": "A team that creates and reviews blog content",
  "created_at": "2026-03-20 10:00:00",
  "updated_at": "2026-03-20 10:00:00"
}
```

## Agents

### Manager Agent

The manager orchestrates workers using delegation tools. The **system prompt is critical** - it tells the LLM how to use its tools to coordinate the team.

```json
{
  "id": 1,
  "user_id": 1,
  "team_id": 1,
  "name": "Content Manager",
  "agent_type": "manager",
  "description": "Coordinates content creation workflow and ensures quality",
  "system_prompt": "You are the Content Manager, orchestrating a team to create high-quality blog content.\n\n## Your Team\n- **Content Writer**: Drafts blog posts and articles. Creative, good with structure.\n- **Content Reviewer**: Reviews for grammar, clarity, engagement. Gives scores 1-10.\n\n## Process\n1. Delegate writing to Content Writer\n2. Pass the draft to Content Reviewer (use context parameter)\n3. If score >= 8: Deliver to user\n   If score < 8: Send back to Writer with feedback for revision\n4. Summarize what was done and present final content\n\n## Rules\n- Always pass previous output as context to the next agent\n- You make final quality decisions\n- Maximum 2 revision cycles, then deliver best version",
  "model": "gpt-4",
  "provider": "openai",
  "temperature": 0.7,
  "max_tokens": 2000,
  "tools": [
    "delegate_to_agent",
    "list_available_agents",
    "run_agents_parallel"
  ],
  "created_at": "2026-03-20 10:00:00"
}
```

### Worker Agent 1: Content Writer

Workers focus on their specialty. They receive tasks from the manager and return results.

```json
{
  "id": 2,
  "user_id": 1,
  "team_id": 1,
  "name": "Content Writer",
  "agent_type": "worker",
  "description": "Writes blog posts and articles based on given topics",
  "system_prompt": "You are a professional content writer specializing in technology topics.\n\n## Your Role\nYou receive writing tasks from the Content Manager. Your job is to produce high-quality first drafts.\n\n## Writing Guidelines\n- Use clear, engaging language\n- Structure with headings (H2, H3)\n- Keep paragraphs short (3-4 sentences)\n- Include practical examples\n- Target audience: tech professionals\n- Aim for the word count specified in the task\n\n## Output Format\nReturn your content in clean Markdown format, ready for review.",
  "model": "gpt-4",
  "provider": "openai",
  "temperature": 0.8,
  "max_tokens": 4000,
  "tools": [],
  "created_at": "2026-03-20 10:05:00"
}
```

### Worker Agent 2: Content Reviewer

```json
{
  "id": 3,
  "user_id": 1,
  "team_id": 1,
  "name": "Content Reviewer",
  "agent_type": "worker",
  "description": "Reviews and improves written content for quality and accuracy",
  "system_prompt": "You are a professional content editor and reviewer.\n\n## Your Role\nYou receive content from the Content Manager to review. Provide constructive feedback to improve quality.\n\n## Review Criteria\nEvaluate each piece on:\n1. **Grammar & Spelling** - Correctness of language\n2. **Clarity** - Easy to understand\n3. **Structure** - Logical flow, good headings\n4. **Engagement** - Interesting to read\n5. **Accuracy** - Facts are correct\n6. **Audience Fit** - Appropriate for tech professionals\n\n## Output Format\nAlways provide:\n```\n## Quality Score: X/10\n\n## Strengths\n- [What works well]\n\n## Areas for Improvement\n- [Specific suggestions]\n\n## Recommended Changes\n1. [Change 1]\n2. [Change 2]\n...\n```\n\nBe specific and actionable in your feedback.",
  "model": "claude-3-sonnet",
  "provider": "anthropic",
  "temperature": 0.3,
  "max_tokens": 2000,
  "tools": [],
  "created_at": "2026-03-20 10:10:00"
}
```

---

## Manager Execution Example

When a user sends: **"Create a blog post about AI trends in 2026"**

### Step 1: Manager Lists Available Agents

The manager calls `list_available_agents`:

```json
{
  "success": true,
  "count": 2,
  "agents": [
    {
      "id": 2,
      "name": "Content Writer",
      "description": "Writes blog posts and articles based on given topics",
      "type": "worker"
    },
    {
      "id": 3,
      "name": "Content Reviewer",
      "description": "Reviews and improves written content for quality and accuracy",
      "type": "worker"
    }
  ]
}
```

### Step 2: Manager Delegates to Content Writer

The manager calls `delegate_to_agent`:

```json
{
  "agent_name": "Content Writer",
  "task": "Write a 600-word blog post about AI trends in 2026. Cover: 1) AI agents and automation, 2) Multimodal AI, 3) AI in enterprise. Target audience: tech professionals.",
  "context": "This is for our company blog. Keep it practical and avoid hype."
}
```

**Response from Content Writer:**
```json
{
  "success": true,
  "agent_name": "Content Writer",
  "result": "# AI Trends Shaping 2026\n\nArtificial intelligence continues to evolve at a rapid pace...\n\n## 1. AI Agents and Automation\n...\n\n## 2. Multimodal AI\n...\n\n## 3. AI in Enterprise\n..."
}
```

### Step 3: Manager Delegates to Content Reviewer

The manager calls `delegate_to_agent` with the draft as context:

```json
{
  "agent_name": "Content Reviewer",
  "task": "Review this blog post for quality and provide improvement suggestions.",
  "context": "# AI Trends Shaping 2026\n\nArtificial intelligence continues to evolve..."
}
```

**Response from Content Reviewer:**
```json
{
  "success": true,
  "agent_name": "Content Reviewer",
  "result": "## Quality Score: 8/10\n\n## Strengths\n- Clear structure with good headings\n- Practical focus as requested\n\n## Areas for Improvement\n- Add a specific example in section 2\n- Conclusion could be stronger\n\n## Recommended Changes\n1. Add a real-world example of multimodal AI (e.g., GPT-4 Vision)\n2. End with a call-to-action for readers"
}
```

### Step 4: Manager Delivers Final Result

Since the score is 8/10 (acceptable), the manager summarizes and delivers:

```
I've coordinated your content team to create this blog post.

**Process:**
1. Content Writer created the initial draft
2. Content Reviewer scored it 8/10 with minor suggestions

**Final Content:**
[The blog post content]

**Reviewer Notes:**
- Consider adding a GPT-4 Vision example in the multimodal section
- Could strengthen the conclusion with a call-to-action

Would you like me to have the writer revise based on this feedback?
```

---

## Alternative: Parallel Execution

For independent tasks, the manager can use `run_agents_parallel`:

```json
{
  "delegations": [
    {
      "agent_name": "Content Writer",
      "task": "Write an introduction paragraph about AI trends"
    },
    {
      "agent_name": "Content Writer",
      "task": "Write a conclusion paragraph about AI trends"
    }
  ]
}
```

This runs both tasks simultaneously and returns combined results.

---

## Delegation Tools Reference

### `delegate_to_agent`

Delegate a task to a single agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | int | No* | ID of the agent |
| `agent_name` | string | No* | Name of the agent |
| `task` | string | **Yes** | The task to perform |
| `context` | string | No | Additional context (e.g., output from previous agent) |

*One of `agent_id` or `agent_name` is required.

### `list_available_agents`

List agents the manager can delegate to.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_type` | string | No | Filter: `worker`, `standard`, or `all` |

### `run_agents_parallel`

Run multiple agents simultaneously.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `delegations` | array | **Yes** | Array of `{agent_name, task, context}` objects |

---

## Key Takeaways

1. **The system prompt is everything** - It teaches the manager how to orchestrate
2. **No workflow needed** - The manager dynamically decides the execution order
3. **Context passing** - Pass outputs between agents via the `context` parameter
4. **Iterative refinement** - Manager can loop (write → review → revise) until satisfied
5. **Manager makes decisions** - Unlike workflows, the manager can adapt based on results
