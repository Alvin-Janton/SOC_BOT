# RAG Tool: Planned, Not Implemented

This is a status/design-boundary document, not an implemented tool guide. No playbook retrieval Lambda, runtime adapter, Bedrock tool definition, or orchestrator dispatch path exists in the current AI stack. The three current model tools are catalog description, event queries, and aggregates. The orchestrator must not claim it retrieved a playbook.

## Approved retrieval intent

[Final Specification section 12](../../../Final_Spec.md#12-rag-and-playbook-retrieval) and the [AI Stack Working Specification](../../../AIStack_Spec-Temp.md) include playbook retrieval in the intended MVP:

- Start with reviewed Markdown playbooks under `playbooks/` and a small index containing document/version/source metadata, categories, keywords, S3 keys, and section headings.
- Accept structured incident categories/indicators and optional keywords, returning a small number of relevant sections with document IDs and source metadata.
- Keep a stable, replaceable retrieval interface so a later Bedrock Knowledge Base can replace the initial deterministic S3-backed retriever without redesigning the agent loop. Vector storage is not an MVP dependency.
- Treat retrieved documents as untrusted reference evidence, not instructions, and preserve provenance. A future retriever's S3 access must be read-only and limited to playbooks, never security logs or evaluation ground truth.

The name `get_incident_playbook` is an approved planned tool contract, not a callable operation today. Exact code layout, deployment resources, implementation/API details, and integration changes await that slice's plan. A permission-boundary allowance for playbook reads does not grant the existing orchestrator S3 access or implement retrieval.

See the [infrastructure guide](../../Infra/README.md), [orchestrator overview](../ChatOrchestrator/README.md), and [agent/tool guide](../ChatOrchestrator/Agent-Loop-and-Tools.md) for components that actually exist.
