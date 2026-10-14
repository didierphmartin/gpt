-- 2026-10-14_scheduled_workflows_orphans.sql — delete schedules whose workflow was deleted.
-- Until 2026-10-14 deleting a workflow left its scheduled_workflows rows behind (MyISAM: no foreign key);
-- WorkflowRepository::delete now removes them. This clears the ones already there.
-- Safe to re-run: it only ever deletes rows whose workflow no longer exists. MySQL 8.x syntax.

-- Review first: the rows this deletes.
SELECT s.id, s.workflow_id, s.repeat_type, s.status, s.trigger_component_id
  FROM scheduled_workflows s
  LEFT JOIN agent_workflows w ON w.id = s.workflow_id
 WHERE w.id IS NULL;

DELETE s FROM scheduled_workflows s
  LEFT JOIN agent_workflows w ON w.id = s.workflow_id
 WHERE w.id IS NULL;
