"""Port of backend/src/AgentTeam/Services/WorkflowRunner.php (414 lines).

Executes multi-step "steps"-based workflows (sequential/condition/transform
steps with `depends_on` ordering). Distinct from GraphWorkflowRunner (graph
node/edge workflows, ported elsewhere) — this is the older linear runner.
PHP `private` methods -> `_name`; PHP has no `protected` methods here.

`AgentRunner` (Task 2) does not exist yet in this port; it is accepted here
via constructor injection typed loosely (`Any`). The only methods this
module calls on it are `run(agent, task, conversation_history, user_id,
context) -> dict`, matching PHP `AgentRunner::run()`'s return shape: a dict
with (at least) `text` (str), optionally `output` (str fallback), `success`
(bool, default True) and `usage` (dict|None).
"""
from __future__ import annotations

import re
import time
from typing import Any

from app.agent_team.models.workflow import Workflow
from app.agent_team.models.workflow import step_dict as _step_dict
from app.support.phpcompat import (
    php_array,
    php_empty,
    php_intval,
    php_items,
    php_loose_eq as _php_loose_eq,
    php_strval,
    php_trim,
    php_values,
)
from app.support.phpjson import php_json_decode, php_json_encode

_NUMERIC_STR_RE = re.compile(r'^-?\d+$')


def _php_array_merge(a, b):
    """PHP array_merge($a, $b): string keys are overwritten by the later
    array's value; integer keys are renumbered/appended rather than
    overwritten (WorkflowRunner.php:58 `array_merge($workflow->getVariables(),
    $inputVariables)`). Both operands are JSON-decoded PHP-array shapes here
    (dict for a JSON object, list for a JSON array / the `[]` default), so
    the only cases that matter in practice are dict+dict (b's keys win) and
    list+list (concatenation); the mixed cases fall back to treating an
    empty non-dict operand as {}."""
    if isinstance(a, list) and isinstance(b, list):
        return list(a) + list(b)
    result: dict = {}
    counter = 0
    for k, v in php_items(a):
        if isinstance(k, int):
            result[counter] = v
            counter += 1
        else:
            result[k] = v
    for k, v in php_items(b):
        if isinstance(k, int):
            result[counter] = v
            counter += 1
        else:
            result[k] = v
    return result




def _isset_index(current, part: str):
    """`isset($current[$part])` for one level of WorkflowRunner::extractField's
    dotted-path walk (PHP 314-331): PHP arrays let a numeric-string key like
    '0' address a list element (int keys and their string forms are the same
    key), so a list is also tried by int(part). `extractField` only checks
    `is_array($data)` once, before the loop, so `$current` can become a
    plain string partway through the walk (a nested value that isn't itself
    an array) — PHP's `isset($string[$n])` is still valid syntax there: a
    (possibly negative, from-the-end) integer offset within the string's
    length returns True with that single character; any non-numeric key is
    False (D3). Returns (found, value)."""
    if isinstance(current, dict):
        if part in current and current[part] is not None:
            return True, current[part]
        return False, None
    if isinstance(current, list):
        if _NUMERIC_STR_RE.match(part):
            i = int(part)
            if 0 <= i < len(current) and current[i] is not None:
                return True, current[i]
        return False, None
    if isinstance(current, str):
        if _NUMERIC_STR_RE.match(part):
            i = int(part)
            idx = i if i >= 0 else len(current) + i
            if 0 <= idx < len(current):
                return True, current[idx]
        return False, None
    return False, None


class WorkflowRunner:
    def __init__(self, db, agent_repository, agent_runner: Any, config: dict | None = None):
        self.db = db
        self.agentRepository = agent_repository
        self.agentRunner = agent_runner
        self.config = config if config is not None else {}

        # Execution context - stores outputs from previous steps
        self.stepOutputs: dict = {}
        # Current workflow execution ID
        self.executionId: int | None = None

    def run(self, workflow: Workflow, user_id: int, input_variables: dict | None = None) -> dict:
        """Run a workflow with given input variables (WorkflowRunner.php 52-145)."""
        input_variables = {} if input_variables is None else input_variables

        # Reset state
        self.stepOutputs = {}

        # Merge input variables with workflow variables
        variables = _php_array_merge(workflow.getVariables(), input_variables)

        # Create execution record
        self.executionId = self._createExecution(workflow, user_id, input_variables)

        start_time = time.time()

        try:
            # Validate workflow
            errors = workflow.validateSteps()
            if not php_empty(errors):
                raise ValueError('Invalid workflow: ' + ', '.join(errors))

            # Get entry steps (no dependencies)
            entry_steps = workflow.getEntrySteps()
            if php_empty(entry_steps):
                raise ValueError('Workflow has no entry steps')

            # Execute steps in dependency order
            completed_steps: list = []
            # PHP: $pendingSteps = $workflow->getSteps(); a JSON-decoded PHP
            # array (dict for an object, list for an array), iterated/unset
            # by original key so completed steps leave a gap rather than
            # reindexing (a Python dict, keyed the same way, mirrors that).
            pending_steps = dict(php_items(workflow.getSteps()))

            while pending_steps:
                executed = False

                for index in list(pending_steps.keys()):
                    step = _step_dict(pending_steps[index])
                    depends_on = step.get('depends_on')
                    depends_on = depends_on if depends_on is not None else []

                    # array_intersect($dependsOn, $completedSteps): elements
                    # of dependsOn present in completedSteps, duplicates in
                    # dependsOn preserved (membership check only).
                    intersect = [d for d in depends_on if d in completed_steps]
                    can_execute = php_empty(depends_on) or len(intersect) == len(depends_on)

                    if can_execute:
                        output = self._executeStep(step, workflow, user_id, variables)

                        output_key = step.get('output_key')
                        output_key = output_key if output_key is not None else step.get('id')
                        self.stepOutputs[output_key] = output
                        variables[output_key] = output

                        completed_steps.append(step.get('id'))
                        del pending_steps[index]
                        executed = True

                if not executed and pending_steps:
                    raise RuntimeError('Workflow has unresolvable dependencies')

            response_time = (time.time() - start_time) * 1000

            # Complete execution
            self._completeExecution(self.executionId, self.stepOutputs, response_time)

            return {
                'success': True,
                'execution_id': self.executionId,
                'workflow': {
                    'id': workflow.getId(),
                    'name': workflow.getName(),
                },
                'outputs': self.stepOutputs,
                'steps_completed': completed_steps,
                'response_time_ms': round(response_time, 2),
            }

        except Exception as e:
            self._failExecution(self.executionId, str(e))

            return {
                'success': False,
                'error': str(e),
                'execution_id': self.executionId,
                'workflow': {
                    'id': workflow.getId(),
                    'name': workflow.getName(),
                },
                'partial_outputs': self.stepOutputs,
            }

    def _executeStep(self, step: dict, workflow: Workflow, user_id: int, variables: dict):
        """WorkflowRunner.php 150-160."""
        step_type = step.get('type')
        step_type = step_type if step_type is not None else 'agent'

        if step_type == 'agent':
            return self._executeAgentStep(step, workflow, user_id, variables)
        if step_type == 'condition':
            return self._executeConditionStep(step, workflow, user_id, variables)
        if step_type == 'transform':
            return self._executeTransformStep(step, variables)
        raise ValueError(f"Unknown step type: {step_type}")

    def _executeAgentStep(self, step: dict, workflow: Workflow, user_id: int, variables: dict) -> dict:
        """WorkflowRunner.php 165-200."""
        agent_name = step.get('agent')
        agent_id = step.get('agent_id')
        task_template = step.get('task_template')
        if task_template is None:
            task_template = step.get('task')
        if task_template is None:
            task_template = ''

        # Find agent
        agent = None
        if not php_empty(agent_id):
            agent = self.agentRepository.findById(agent_id)
        elif not php_empty(agent_name):
            agent = self.agentRepository.findByName(agent_name, user_id)

        if not agent:
            identifier = agent_name if agent_name is not None else agent_id
            raise RuntimeError('Agent not found: ' + php_strval(identifier))

        # Interpolate variables in task
        task = workflow.interpolateVariables(task_template, variables)

        # Run agent
        result = self.agentRunner.run(agent, task, [], user_id, {
            'workflow_execution_id': self.executionId,
            'step_id': step.get('id'),
        })

        result_text = result.get('text')
        if result_text is None:
            result_text = result.get('output')
        if result_text is None:
            result_text = ''

        return {
            'agent': agent.getName(),
            'agent_id': agent.getId(),
            'task': task,
            'result': result_text,
            'success': result.get('success') if result.get('success') is not None else True,
            'usage': result.get('usage'),
        }

    def _executeConditionStep(self, step: dict, workflow: Workflow, user_id: int, variables: dict) -> dict:
        """WorkflowRunner.php 205-236."""
        condition = step.get('condition')
        condition = condition if condition is not None else ''
        then_step = step.get('then')
        else_step = step.get('else')

        condition_met = self._evaluateCondition(condition, variables)

        if condition_met and not php_empty(then_step):
            return {
                'condition': condition,
                'result': True,
                'branch': 'then',
                'output': self._executeStep(then_step, workflow, user_id, variables),
            }
        if (not condition_met) and not php_empty(else_step):
            return {
                'condition': condition,
                'result': False,
                'branch': 'else',
                'output': self._executeStep(else_step, workflow, user_id, variables),
            }

        return {
            'condition': condition,
            'result': condition_met,
            'branch': 'none',
            'output': None,
        }

    def _executeTransformStep(self, step: dict, variables: dict) -> dict:
        """WorkflowRunner.php 241-261."""
        transform = step.get('transform')
        transform = transform if transform is not None else ''
        input_key = step.get('input')
        # PHP arrays are value types: `$inputData = $variables;` snapshots the
        # array at this point, so later `$variables[$outputKey] = $output`
        # mutations can't leak into (or self-reference through) the stored
        # $inputData. Python dicts are reference types, so mirror the PHP
        # copy-on-assign here with a shallow copy — without it, storing this
        # transform's own output back into `variables` (run()'s
        # `variables[output_key] = output`) would make `output['output']`
        # alias `variables` and become self-referential the moment that
        # assignment lands.
        input_data = variables.get(input_key) if not php_empty(input_key) else dict(variables)

        if transform == 'json_encode':
            output = php_json_encode(input_data)
        elif transform == 'json_decode':
            output = php_json_decode(input_data) if isinstance(input_data, str) else input_data
        elif transform == 'combine':
            inputs = step.get('inputs')
            output = self._combineOutputs(inputs if inputs is not None else [], variables)
        elif transform == 'extract':
            field = step.get('field')
            output = self._extractField(input_data, field if field is not None else '')
        elif transform == 'summarize':
            inputs = step.get('inputs')
            output = self._summarizeOutputs(inputs if inputs is not None else [], variables)
        else:
            output = input_data

        return {
            'transform': transform,
            'output': output,
        }

    def _evaluateCondition(self, condition: str, variables: dict) -> bool:
        """WorkflowRunner.php 266-295. Supports simple conditions:
        "varname", "!varname", "varname == value", "varname != value"."""
        condition = php_trim(condition)

        # Negation
        if condition.startswith('!'):
            var_name = condition[1:]
            return php_empty(variables.get(var_name))

        # Equality check
        if '==' in condition:
            left, right = (php_trim(part) for part in condition.split('==', 1))
            left_value = variables[left] if (left in variables and variables[left] is not None) else left
            right_value = variables[right] if (right in variables and variables[right] is not None) else right
            return _php_loose_eq(left_value, right_value)

        # Inequality check
        if '!=' in condition:
            left, right = (php_trim(part) for part in condition.split('!=', 1))
            left_value = variables[left] if (left in variables and variables[left] is not None) else left
            right_value = variables[right] if (right in variables and variables[right] is not None) else right
            return not _php_loose_eq(left_value, right_value)

        # Simple truthiness check
        return not php_empty(variables.get(condition))

    def _combineOutputs(self, input_keys, variables: dict) -> dict:
        """WorkflowRunner.php 300-309."""
        combined: dict = {}
        for key in php_values(input_keys):
            if key in variables and variables[key] is not None:
                combined[key] = variables[key]
        return combined

    def _extractField(self, data, field: str):
        """WorkflowRunner.php 314-331."""
        if not isinstance(data, (dict, list)):
            return None

        parts = field.split('.')
        current = data

        for part in parts:
            found, value = _isset_index(current, part)
            if not found:
                return None
            current = value

        return current

    def _summarizeOutputs(self, input_keys, variables: dict) -> str:
        """WorkflowRunner.php 336-350."""
        summaries: list = []
        for key in php_values(input_keys):
            if key in variables and variables[key] is not None:
                value = variables[key]
                if isinstance(value, (dict, list)):
                    result = value.get('result') if isinstance(value, dict) else None
                    text = php_strval(result) if result is not None else php_json_encode(value)
                    summaries.append(f"{php_strval(key)}: {text}")
                else:
                    summaries.append(f"{php_strval(key)}: {php_strval(value)}")
        return "\n\n".join(summaries)

    def _createExecution(self, workflow: Workflow, user_id: int, input_variables: dict) -> int:
        """WorkflowRunner.php 355-368. `$inputVariables` is a typed PHP
        `array` param — an empty one must serialise as `[]`, not `{}`."""
        return self.db.insert(
            "INSERT INTO agent_workflow_executions (workflow_id, user_id, input_variables, status, started_at)\n"
            "             VALUES (?, ?, ?, 'running', NOW())",
            [workflow.getId(), user_id, php_json_encode(php_array(input_variables))],
        )

    def _completeExecution(self, execution_id: int, outputs: dict, response_time: float) -> None:
        """WorkflowRunner.php 373-385. `$outputs` is a typed PHP `array`
        param — an empty one must serialise as `[]`, not `{}`."""
        self.db.execute(
            "UPDATE agent_workflow_executions\n"
            "             SET status = 'completed', output = ?, response_time_ms = ?, completed_at = NOW()\n"
            "             WHERE id = ?",
            [php_json_encode(php_array(outputs)), php_intval(response_time), execution_id],
        )

    def _failExecution(self, execution_id: int, error: str) -> None:
        """WorkflowRunner.php 390-398."""
        self.db.execute(
            "UPDATE agent_workflow_executions\n"
            "             SET status = 'failed', error_message = ?, completed_at = NOW()\n"
            "             WHERE id = ?",
            [error, execution_id],
        )

    def getExecutionHistory(self, workflow_id: int, limit: int = 50, offset: int = 0) -> list:
        """WorkflowRunner.php 403-413."""
        return self.db.fetch_all(
            "SELECT * FROM agent_workflow_executions\n"
            "             WHERE workflow_id = ?\n"
            "             ORDER BY started_at DESC\n"
            "             LIMIT ? OFFSET ?",
            [workflow_id, limit, offset],
        )
