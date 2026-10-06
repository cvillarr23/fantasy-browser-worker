// Same cluster-DNS-default convention as OLLAMA_URL in src/lib/llm_client.js — verified against
// fantasy-infra's base/core-pipeline/fastapi-service.yaml (ClusterIP service
// "fantasy-core-pipeline", port 8000, default namespace).
const CORE_PIPELINE_URL =
  process.env.CORE_PIPELINE_URL ||
  "http://fantasy-core-pipeline.default.svc.cluster.local:8000";

module.exports = { CORE_PIPELINE_URL };
