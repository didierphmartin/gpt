-- MLflow tracing: a workflow property, like orchestration. When on, every
-- compiled program of the workflow (LangGraph, ADK, MAF, NOOA; every layout)
-- sends its traces to the MLflow server named by MLFLOW_TRACKING_URI.
-- Off (0) for every existing workflow.
-- Runs against the CONTEXTS database (netfo587_chatbot), where workflows live.
ALTER TABLE agent_workflows
  ADD COLUMN mlflow_tracing TINYINT(1) NOT NULL DEFAULT 0
  AFTER orchestration;
