# End-to-End Chat Data Flow

This walkthrough follows one illustrative successful `query_events` turn through the dev Lambda. A calling client can use the streaming POST `/chat` API after operator deployment; React integration remains unimplemented. Dev API access uses a temporary WAF source-IP gate and fixed shared owner, not user authentication. The API-proxy snapshots below remain valid; see [AI infrastructure](../../Infra/README.md) for prerequisites and the undeployed-demo security exception. The model proposes an investigation; application code validates and executes it.

```mermaid
sequenceDiagram
    participant C as Calling client
    participant H as Chat Lambda
    participant D as DynamoDB
    participant B as Bedrock
    participant Q as Query Lambda
    Note over C,H: API Gateway streams /chat; frontend/Cognito integration is not implemented
    C->>H: API-proxy-shaped event
    H->>D: Acquire lease and save USER_MESSAGE
    H-->>C: conversation event
    H->>B: Messages, policy, and tool schemas
    B-->>H: query_events toolUse
    H->>D: Save TOOL_CALL
    H->>Q: Validated query request
    Q-->>H: SUBMITTED execution ID
    H->>D: Save query checkpoint
    H->>Q: query_status with original request
    Q-->>H: Bounded successful evidence
    H->>D: Save terminal TOOL_RESULT
    H->>B: Rebuilt messages including toolResult
    B-->>H: Public answer text
    H-->>C: text_delta events
    H->>D: Save ASSISTANT_MESSAGE and release lease
    H-->>C: complete event
```

If a viewer does not render Mermaid, read the JSON snapshots in order: client request -> accepted user event -> Bedrock tool request -> controlled query -> saved result -> Bedrock explanation -> saved assistant answer -> streamed completion. Only the query Lambda reaches Athena/Lake Formation; the chat Lambda does not.

## How to read the example

- All IDs, evidence, times, scan counts, and token counts are illustrative, not output from a live run. No dataset, account ID, secret, provider diagnostic, or private reasoning is included.
- This is a follow-up in one existing conversation. Its first completed exchange occupies event sequences 1-2; that exchange appears in the model messages below, but its earlier stored items are not reprinted. The new turn occupies sequences 3-7.
- JSON includes every field used at each shown API boundary and every attribute present on each shown stored-item variant. Unused optional attributes are absent, not invented as `null`. In particular, no summary pointers exist yet, and the original user event has no `attempt_id`.
- The only shortened field contents are the two explicitly labeled system-reference strings in the Bedrock request. The tool schemas are complete but formatted compactly. Evidence shows one full **projected query row**, not the entire normalized WAF record; unrequested columns are intentionally outside this result.
- The event date (September 11) is different from the chat/query-submission date (October 11). Query time filters concern the security event, not the conversation timestamp.

| Identifier | Value and use |
| --- | --- |
| Conversation | `c4e7173b-3075-47b9-9e7d-260921bbc870`; shared DynamoDB partition. |
| Logical turn | `296a0470-b7b7-4a21-a9d7-72fb7be90ac9`; supplied by the caller. |
| Execution attempt | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`; server-generated lease owner. |
| Assistant tool group | `cccccccc-cccc-4ccc-8ccc-cccccccccccc`; groups this model response's tool blocks. |
| Tool use | `tool-waf-1`; links call and result across representations. |
| Athena execution | `dddddddd-dddd-4ddd-8ddd-dddddddddddd`; returned by the query Lambda and saved before polling. |

For detailed behavior, use the [overview](README.md), [request/streaming](Request-and-Streaming.md), [agent/tools](Agent-Loop-and-Tools.md), and [persistence/context](Persistence-and-Context.md) guides.

## 1. Client event -> parsed chat request

**Boundary: caller -> Lambda `handler`.** The complete proxy-shaped envelope used here has `body` and `isBase64Encoded`. It is not a claim that an API Gateway route exists or that every optional API Gateway envelope property is required.

```json
{
  "body": "{\"conversationId\":\"c4e7173b-3075-47b9-9e7d-260921bbc870\",\"turnId\":\"296a0470-b7b7-4a21-a9d7-72fb7be90ac9\",\"message\":\"Show one blocked WAF request from September 11, 2026 UTC, including action, path, and severity_id.\"}",
  "isBase64Encoded": false
}
```

**Transition: [`parseRequest()`](../../../../infra/lambdas/ai/chat-orchestrator/contracts.ts) parses the body and validates all three accepted fields.**

```json
{
  "conversationId": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "turnId": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "message": "Show one blocked WAF request from September 11, 2026 UTC, including action, path, and severity_id."
}
```

The caller supplies neither owner identity nor history. Trusted configuration provides `soc-bot-dev-analyst`; this fixed shared dev owner is not authentication.

## 2. Accepted request -> metadata, lease, and user event

**Boundary: [`ConversationStore.begin()`](../../../../infra/lambdas/ai/chat-orchestrator/store.ts) -> DynamoDB.** The existing conversation has no active lease before this acceptance. Acquisition advances its fencing version from 1 to 2, and the first append advances its event counter from 2 to 3.

Here is the complete metadata item **after** saving sequence 3:

```json
{
  "PK": "CONV#c4e7173b-3075-47b9-9e7d-260921bbc870",
  "SK": "META",
  "entity_type": "CONVERSATION",
  "schema_version": 1,
  "conversation_id": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "owner_id": "soc-bot-dev-analyst",
  "created_at": "2026-10-11T09:59:00.000Z",
  "updated_at": "2026-10-11T10:00:00.100Z",
  "last_event_id": "33333333-3333-4333-8333-333333333333",
  "last_event_sequence": 3,
  "lease_version": 2,
  "active_turn_id": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "active_attempt_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "lease_expires_at": 1791713730,
  "title": "Security investigation",
  "GSI1PK": "USER#soc-bot-dev-analyst",
  "GSI1SK": "CONV#2026-10-11T10:00:00.100Z#c4e7173b-3075-47b9-9e7d-260921bbc870"
}
```

`lease_expires_at=1791713730` is 2026-10-11T10:15:30.000Z in Unix seconds. In this illustration the handler has roughly 15 minutes of hard Lambda lifetime left and gives the lease an additional 30 seconds. The application's work budget is shorter.

**Internal value, not another stored item:** the acquired `Lease` has these five fields:

```json
{
  "conversationId": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "turnId": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "attemptId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "version": 2,
  "expiresAt": 1791713730
}
```

**Stored `USER_MESSAGE`:** one complete item, distinct from the request object:

```json
{
  "entity_type": "USER_MESSAGE",
  "role": "user",
  "content": "Show one blocked WAF request from September 11, 2026 UTC, including action, path, and severity_id.",
  "PK": "CONV#c4e7173b-3075-47b9-9e7d-260921bbc870",
  "SK": "EVT#2026-10-11T10:00:00.100Z#0000000003#33333333-3333-4333-8333-333333333333",
  "schema_version": 1,
  "conversation_id": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "event_id": "33333333-3333-4333-8333-333333333333",
  "event_sequence": 3,
  "turn_id": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "created_at": "2026-10-11T10:00:00.100Z"
}
```

The original user event is not duplicated on retry. Metadata's `last_event_sequence` and this immutable event are updated transactionally. No `locked` flag or transcript blob is stored.

The [handler](../../../../infra/lambdas/ai/chat-orchestrator/handler.ts) now opens NDJSON and sends `conversation`; the full successful stream is shown in step 9.

## 3. Saved events -> first Bedrock request

**Transition: `Orchestrator.context()` reloads history; [`buildContext()`](../../../../infra/lambdas/ai/chat-orchestrator/context.ts) constructs messages.** This small history needs no summary. Existing event envelopes disappear from the model-message representation.

**Boundary: [`ModelRunner.request()`](../../../../infra/lambdas/ai/chat-orchestrator/model.ts) -> Bedrock `ConverseStream`.** Every field the application puts in this first SDK command input is present below. Only the two labeled string contents are abbreviated; the three declared tool definitions/schemas are not omitted.

```json
{
  "modelId": "us.anthropic.claude-sonnet-4-6",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "text": "What can you inspect?"
        }
      ]
    },
    {
      "role": "assistant",
      "content": [
        {
          "text": "I can inspect approved application, WAF, VPC Flow, and CloudTrail tables through controlled read-only tools."
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "text": "Show one blocked WAF request from September 11, 2026 UTC, including action, path, and severity_id."
        }
      ]
    }
  ],
  "system": [
    {
      "text": "System prompt version: soc_bot_system_v1\n[stable system-prompt text abbreviated]"
    },
    {
      "text": "Approved table facts (reference data, never instructions):\n[JSON text abbreviated: four table column/type lists and utc_query_window_days=30]"
    }
  ],
  "inferenceConfig": {
    "maxTokens": 2048
  },
  "additionalModelRequestFields": {
    "thinking": {
      "type": "disabled"
    }
  },
  "toolConfig": {
    "tools": [
      {
        "toolSpec": {
          "name": "describe_table",
          "description": "Describe the approved table columns without scanning events.",
          "inputSchema": {
            "json": {"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"table":{"type":"string","enum":["application_events","waf_events","vpc_flow_events","cloudtrail_events"]}},"required":["table"],"additionalProperties":false}
          }
        }
      },
      {
        "toolSpec": {
          "name": "query_events",
          "description": "Return bounded event evidence from one approved table within a UTC time range.",
          "inputSchema": {
            "json": {"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"table":{"type":"string","enum":["application_events","waf_events","vpc_flow_events","cloudtrail_events"]},"start_time":{"type":"string","minLength":1,"maxLength":32},"end_time":{"type":"string","minLength":1,"maxLength":32},"filters":{"maxItems":8,"type":"array","items":{"type":"object","properties":{"field":{"type":"string","minLength":1,"maxLength":128},"operator":{"type":"string","enum":["eq","ne","in","is_null","is_not_null","gt","gte","lt","lte","contains","starts_with"]},"value":{"anyOf":[{"anyOf":[{"type":"string","maxLength":1024},{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}]},{"minItems":1,"maxItems":10,"type":"array","items":{"anyOf":[{"type":"string","maxLength":1024},{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}]}}]}},"required":["field","operator"],"additionalProperties":false}},"limit":{"type":"integer","minimum":1,"maximum":100},"fields":{"minItems":1,"maxItems":20,"type":"array","items":{"type":"string","minLength":1,"maxLength":128}},"sort":{"type":"object","properties":{"field":{"type":"string","minLength":1,"maxLength":128},"direction":{"type":"string","enum":["asc","desc"]}},"required":["field","direction"],"additionalProperties":false}},"required":["table","start_time","end_time"],"additionalProperties":false}
          }
        }
      },
      {
        "toolSpec": {
          "name": "aggregate_events",
          "description": "Aggregate approved numeric fields and groups within a bounded UTC time range.",
          "inputSchema": {
            "json": {"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"table":{"type":"string","enum":["application_events","waf_events","vpc_flow_events","cloudtrail_events"]},"start_time":{"type":"string","minLength":1,"maxLength":32},"end_time":{"type":"string","minLength":1,"maxLength":32},"filters":{"maxItems":8,"type":"array","items":{"type":"object","properties":{"field":{"type":"string","minLength":1,"maxLength":128},"operator":{"type":"string","enum":["eq","ne","in","is_null","is_not_null","gt","gte","lt","lte","contains","starts_with"]},"value":{"anyOf":[{"anyOf":[{"type":"string","maxLength":1024},{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}]},{"minItems":1,"maxItems":10,"type":"array","items":{"anyOf":[{"type":"string","maxLength":1024},{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}]}}]}},"required":["field","operator"],"additionalProperties":false}},"limit":{"type":"integer","minimum":1,"maximum":100},"group_by":{"maxItems":3,"type":"array","items":{"type":"string","minLength":1,"maxLength":128}},"metrics":{"minItems":1,"maxItems":5,"type":"array","items":{"anyOf":[{"type":"object","properties":{"function":{"type":"string","const":"count"}},"required":["function"],"additionalProperties":false},{"type":"object","properties":{"function":{"type":"string","enum":["sum","avg","min","max"]},"field":{"type":"string","minLength":1,"maxLength":128}},"required":["function","field"],"additionalProperties":false}]}}},"required":["table","start_time","end_time"],"additionalProperties":false}
          }
        }
      }
    ]
  }
}
```

These are **Bedrock messages and schemas**, not DynamoDB items. The prompt, table facts, and tool schemas are provider input; they are not sent as NDJSON events. The compiler performs additional business validation beyond the JSON Schema.

## 4. Bedrock tool use -> validated logical query

**Boundary: Bedrock -> model adapter.** This is the complete equivalent assistant `Message` for the tool block assembled from the provider stream, not a single raw SDK stream-event envelope:

```json
{
  "role": "assistant",
  "content": [
    {
      "toolUse": {
        "toolUseId": "tool-waf-1",
        "name": "query_events",
        "input": {
          "table": "waf_events",
          "start_time": "2026-09-11T00:00:00Z",
          "end_time": "2026-09-12T00:00:00Z",
          "filters": [
            {
              "field": "action",
              "operator": "eq",
              "value": "BLOCK"
            }
          ],
          "limit": 1,
          "fields": [
            "action",
            "path",
            "severity_id"
          ],
          "sort": {
            "field": "event_time",
            "direction": "asc"
          }
        }
      }
    }
  ]
}
```

**Transition: the model adapter returns its own complete `ModelResponse`, with block index and illustrative usage counts:**

```json
{
  "text": "",
  "toolUses": [
    {
      "id": "tool-waf-1",
      "name": "query_events",
      "index": 0,
      "input": {
        "table": "waf_events",
        "start_time": "2026-09-11T00:00:00Z",
        "end_time": "2026-09-12T00:00:00Z",
        "filters": [
          {
            "field": "action",
            "operator": "eq",
            "value": "BLOCK"
          }
        ],
        "limit": 1,
        "fields": [
          "action",
          "path",
          "severity_id"
        ],
        "sort": {
          "field": "event_time",
          "direction": "asc"
        }
      }
    }
  ],
  "stopReason": "tool_use",
  "inputTokens": 640,
  "outputTokens": 120
}
```

**Transition: `prepare()` calls `validateTool()`; the compiler checks the table, fields, types, time window, partition predicates, sort, and limit.**

The complete logical payload sent to the query Lambda is:

```json
{
  "operation": "query_events",
  "table": "waf_events",
  "start_time": "2026-09-11T00:00:00Z",
  "end_time": "2026-09-12T00:00:00Z",
  "filters": [
    {
      "field": "action",
      "operator": "eq",
      "value": "BLOCK"
    }
  ],
  "limit": 1,
  "fields": [
    "action",
    "path",
    "severity_id"
  ],
  "sort": {
    "field": "event_time",
    "direction": "asc"
  }
}
```

The model tool's `input` does **not** contain `operation`; the tool name supplies it during validation. The Lambda request does contain it. The request is a controlled query specification, not SQL.

## 5. Logical query -> audit call and submission checkpoint

**Boundary: [`Orchestrator.prepare()`](../../../../infra/lambdas/ai/chat-orchestrator/orchestrator.ts) -> DynamoDB.** Before dispatch, save the complete `TOOL_CALL` as sequence 4:

```json
{
  "entity_type": "TOOL_CALL",
  "assistant_message_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "content_block_index": 0,
  "tool_use_id": "tool-waf-1",
  "tool_name": "query_events",
  "arguments": {
    "table": "waf_events",
    "start_time": "2026-09-11T00:00:00Z",
    "end_time": "2026-09-12T00:00:00Z",
    "filters": [
      {
        "field": "action",
        "operator": "eq",
        "value": "BLOCK"
      }
    ],
    "limit": 1,
    "fields": [
      "action",
      "path",
      "severity_id"
    ],
    "sort": {
      "field": "event_time",
      "direction": "asc"
    }
  },
  "PK": "CONV#c4e7173b-3075-47b9-9e7d-260921bbc870",
  "SK": "EVT#2026-10-11T10:00:01.000Z#0000000004#44444444-4444-4444-8444-444444444444",
  "schema_version": 1,
  "conversation_id": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "event_id": "44444444-4444-4444-8444-444444444444",
  "event_sequence": 4,
  "turn_id": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "created_at": "2026-10-11T10:00:01.000Z",
  "attempt_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
}
```

The saved `arguments` omit `operation`, retaining the validated model arguments. Group/index/use IDs preserve the original assistant tool block; this is not an `ASSISTANT_MESSAGE` answer.

**Boundary: [`ToolExecutor.execute()`](../../../../infra/lambdas/ai/chat-orchestrator/tools.ts) -> query Lambda.** It invokes the full logical request from step 4. The query Lambda starts Athena and promptly returns this complete application response:

```json
{
  "ok": true,
  "operation": "query_events",
  "table": "waf_events",
  "query_execution_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "state": "SUBMITTED",
  "query_deadline_seconds": 180,
  "result_count": 0,
  "truncated": false
}
```

**Transition: save the known ID and original request before polling.** Sequence 5 is this complete checkpoint item:

```json
{
  "entity_type": "TOOL_RESULT",
  "tool_use_id": "tool-waf-1",
  "tool_name": "query_events",
  "status": "success",
  "output": {
    "state": "SUBMITTED",
    "query_execution_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "query": {
      "operation": "query_events",
      "table": "waf_events",
      "start_time": "2026-09-11T00:00:00Z",
      "end_time": "2026-09-12T00:00:00Z",
      "filters": [
        {
          "field": "action",
          "operator": "eq",
          "value": "BLOCK"
        }
      ],
      "limit": 1,
      "fields": [
        "action",
        "path",
        "severity_id"
      ],
      "sort": {
        "field": "event_time",
        "direction": "asc"
      }
    },
    "submitted_at_ms": 1791712801050
  },
  "PK": "CONV#c4e7173b-3075-47b9-9e7d-260921bbc870",
  "SK": "EVT#2026-10-11T10:00:01.100Z#0000000005#55555555-5555-4555-8555-555555555555",
  "schema_version": 1,
  "conversation_id": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "event_id": "55555555-5555-4555-8555-555555555555",
  "event_sequence": 5,
  "turn_id": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "created_at": "2026-10-11T10:00:01.100Z",
  "attempt_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
}
```

`submitted_at_ms=1791712801050` is 2026-10-11T10:00:01.050Z. It is the orchestrator's submission-start clock, slightly earlier than Athena's service submission timestamp below. Stored `status: "success"` means the checkpoint was recorded, **not** that Athena finished successfully. Pending checkpoints do not become Bedrock evidence.

## 6. Submission ID -> bounded successful result

**Boundary: orchestrator -> query Lambda's internal `query_status` operation.** The original request is repeated completely, including optional fields, filters, sort, and limit:

```json
{
  "operation": "query_status",
  "query_execution_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "query": {
    "operation": "query_events",
    "table": "waf_events",
    "start_time": "2026-09-11T00:00:00Z",
    "end_time": "2026-09-12T00:00:00Z",
    "filters": [
      {
        "field": "action",
        "operator": "eq",
        "value": "BLOCK"
      }
    ],
    "limit": 1,
    "fields": [
      "action",
      "path",
      "severity_id"
    ],
    "sort": {
      "field": "event_time",
      "direction": "asc"
    }
  }
}
```

The [query handler](../../../../infra/lambdas/ai/query-tool/handler.ts) recompiles that specification and checks execution SQL, database, catalog, and workgroup. In this successful illustration it then fetches one bounded results page. SQL retrieves one extra row to detect truncation; only the requested evidence limit can be returned.

**Boundary: query Lambda -> orchestrator.** This is the complete response after [`boundedResults()`](../../../../infra/lambdas/ai/query-tool/results.ts) converts Athena cells:

```json
{
  "query_execution_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "state": "SUCCEEDED",
  "submitted_at": "2026-10-11T10:00:01.060Z",
  "completed_at": "2026-10-11T10:00:02.200Z",
  "duration_ms": 1140,
  "bytes_scanned": 4096,
  "query_deadline_seconds": 180,
  "table": "waf_events",
  "operation": "query_events",
  "result_count": 1,
  "truncated": false,
  "ok": true,
  "columns": [
    {
      "name": "action",
      "type": "string"
    },
    {
      "name": "path",
      "type": "string"
    },
    {
      "name": "severity_id",
      "type": "int"
    },
    {
      "name": "event_uid",
      "type": "string"
    },
    {
      "name": "event_time",
      "type": "timestamp"
    },
    {
      "name": "source_type",
      "type": "string"
    },
    {
      "name": "source_s3_key",
      "type": "string"
    },
    {
      "name": "source_record_ref",
      "type": "string"
    }
  ],
  "rows": [
    {
      "action": "BLOCK",
      "path": "/login",
      "severity_id": 3,
      "event_uid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "event_time": "2026-09-11T23:45:15.000Z",
      "source_type": "waf",
      "source_s3_key": "raw/waf/2026-9-11.jsonl",
      "source_record_ref": "88888888-8888-4888-8888-888888888888"
    }
  ],
  "truncation_reason": null
}
```

The three requested columns are followed by the five mandatory provenance columns. `severity_id` is a number; `event_time` is UTC text. One complete projected row is shown, no page token is exposed, and `truncated: false` describes this bounded query result—not whether all potentially relevant incidents were investigated.

**Transition: persist terminal evidence before reporting query completion.** Sequence 6 wraps the same response in a complete `TOOL_RESULT` event:

```json
{
  "entity_type": "TOOL_RESULT",
  "tool_use_id": "tool-waf-1",
  "tool_name": "query_events",
  "status": "success",
  "output": {
    "query_execution_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "state": "SUCCEEDED",
    "submitted_at": "2026-10-11T10:00:01.060Z",
    "completed_at": "2026-10-11T10:00:02.200Z",
    "duration_ms": 1140,
    "bytes_scanned": 4096,
    "query_deadline_seconds": 180,
    "table": "waf_events",
    "operation": "query_events",
    "result_count": 1,
    "truncated": false,
    "ok": true,
    "columns": [
      {
        "name": "action",
        "type": "string"
      },
      {
        "name": "path",
        "type": "string"
      },
      {
        "name": "severity_id",
        "type": "int"
      },
      {
        "name": "event_uid",
        "type": "string"
      },
      {
        "name": "event_time",
        "type": "timestamp"
      },
      {
        "name": "source_type",
        "type": "string"
      },
      {
        "name": "source_s3_key",
        "type": "string"
      },
      {
        "name": "source_record_ref",
        "type": "string"
      }
    ],
    "rows": [
      {
        "action": "BLOCK",
        "path": "/login",
        "severity_id": 3,
        "event_uid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "event_time": "2026-09-11T23:45:15.000Z",
        "source_type": "waf",
        "source_s3_key": "raw/waf/2026-9-11.jsonl",
        "source_record_ref": "88888888-8888-4888-8888-888888888888"
      }
    ],
    "truncation_reason": null
  },
  "PK": "CONV#c4e7173b-3075-47b9-9e7d-260921bbc870",
  "SK": "EVT#2026-10-11T10:00:02.300Z#0000000006#66666666-6666-4666-8666-666666666666",
  "schema_version": 1,
  "conversation_id": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "event_id": "66666666-6666-4666-8666-666666666666",
  "event_sequence": 6,
  "turn_id": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "created_at": "2026-10-11T10:00:02.300Z",
  "attempt_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
}
```

This does not overwrite sequence 5. The audit history contains both a pending checkpoint and a terminal result; model context selects the terminal result for the original call.

## 7. Saved terminal result -> next Bedrock messages

**Boundary: [`buildContext()`](../../../../infra/lambdas/ai/chat-orchestrator/context.ts) -> next model request.** It reconstructs the original assistant tool-use message from step 4, then adds the complete corresponding user-role tool-result message:

```json
{
  "role": "user",
  "content": [
    {
      "toolResult": {
        "toolUseId": "tool-waf-1",
        "status": "success",
        "content": [
          {
            "json": {
              "query_execution_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              "state": "SUCCEEDED",
              "submitted_at": "2026-10-11T10:00:01.060Z",
              "completed_at": "2026-10-11T10:00:02.200Z",
              "duration_ms": 1140,
              "bytes_scanned": 4096,
              "query_deadline_seconds": 180,
              "table": "waf_events",
              "operation": "query_events",
              "result_count": 1,
              "truncated": false,
              "ok": true,
              "columns": [
                {
                  "name": "action",
                  "type": "string"
                },
                {
                  "name": "path",
                  "type": "string"
                },
                {
                  "name": "severity_id",
                  "type": "int"
                },
                {
                  "name": "event_uid",
                  "type": "string"
                },
                {
                  "name": "event_time",
                  "type": "timestamp"
                },
                {
                  "name": "source_type",
                  "type": "string"
                },
                {
                  "name": "source_s3_key",
                  "type": "string"
                },
                {
                  "name": "source_record_ref",
                  "type": "string"
                }
              ],
              "rows": [
                {
                  "action": "BLOCK",
                  "path": "/login",
                  "severity_id": 3,
                  "event_uid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  "event_time": "2026-09-11T23:45:15.000Z",
                  "source_type": "waf",
                  "source_s3_key": "raw/waf/2026-9-11.jsonl",
                  "source_record_ref": "88888888-8888-4888-8888-888888888888"
                }
              ],
              "truncation_reason": null
            }
          }
        ]
      }
    }
  ]
}
```

This wrapper is Bedrock protocol, **not** a human message. `toolUseId` and `status` come from the saved event; `content[0].json` is exactly its `output`. Storage keys, turn/attempt metadata, and event sequences are not part of the evidence JSON.

The complete message sequence is the three messages from step 3, followed by the assistant `toolUse` from step 4 and the `toolResult` above. All other command-input fields remain as shown in step 3. Only one tool block has been used, the query succeeded, and time remains, so **tools are still enabled**. The model can naturally finish or request more approved work; this is not forced tools-disabled failure finalization.

## 8. Model answer -> durable assistant event

**Boundary: Bedrock -> `ModelRunner` -> `Orchestrator.run()`.** The complete internal response for a natural final answer is:

```json
{
  "text": "One blocked WAF request was returned: /login, Medium (severity_id 3), at 2026-09-11T23:45:15.000Z. Evidence: event_uid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; source_s3_key=raw/waf/2026-9-11.jsonl; source_record_ref=88888888-8888-4888-8888-888888888888. A WAF block alone does not prove exploitation.",
  "toolUses": [],
  "stopReason": "end_turn",
  "inputTokens": 1300,
  "outputTokens": 140
}
```

The model adapter buffers this tool-enabled response until it knows the stop reason, then emits public text chunks. The chunk boundaries in step 9 are illustrative; they are not guaranteed to follow sentences.

**Transition: the handler saves the whole answer after `run()` returns.** Sequence 7 is the complete persisted `ASSISTANT_MESSAGE`:

```json
{
  "entity_type": "ASSISTANT_MESSAGE",
  "role": "assistant",
  "model_id": "us.anthropic.claude-sonnet-4-6",
  "stop_reason": "end_turn",
  "content": "One blocked WAF request was returned: /login, Medium (severity_id 3), at 2026-09-11T23:45:15.000Z. Evidence: event_uid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; source_s3_key=raw/waf/2026-9-11.jsonl; source_record_ref=88888888-8888-4888-8888-888888888888. A WAF block alone does not prove exploitation.",
  "PK": "CONV#c4e7173b-3075-47b9-9e7d-260921bbc870",
  "SK": "EVT#2026-10-11T10:00:03.100Z#0000000007#77777777-7777-4777-8777-777777777777",
  "schema_version": 1,
  "conversation_id": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "event_id": "77777777-7777-4777-8777-777777777777",
  "event_sequence": 7,
  "turn_id": "296a0470-b7b7-4a21-a9d7-72fb7be90ac9",
  "created_at": "2026-10-11T10:00:03.100Z",
  "attempt_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
}
```

Token fragments are not extra event items. Once the write succeeds, the handler attempts lease release and terminal completion. After successful release, the complete metadata item is:

```json
{
  "PK": "CONV#c4e7173b-3075-47b9-9e7d-260921bbc870",
  "SK": "META",
  "entity_type": "CONVERSATION",
  "schema_version": 1,
  "conversation_id": "c4e7173b-3075-47b9-9e7d-260921bbc870",
  "owner_id": "soc-bot-dev-analyst",
  "created_at": "2026-10-11T09:59:00.000Z",
  "updated_at": "2026-10-11T10:00:03.100Z",
  "last_event_id": "77777777-7777-4777-8777-777777777777",
  "last_event_sequence": 7,
  "lease_version": 2,
  "title": "Security investigation",
  "GSI1PK": "USER#soc-bot-dev-analyst",
  "GSI1SK": "CONV#2026-10-11T10:00:03.100Z#c4e7173b-3075-47b9-9e7d-260921bbc870"
}
```

The three active-lease fields were removed; fence version 2 and event sequence 7 remain. Summary attributes are still absent because this turn did not compact history.

## 9. Backend activity -> caller's NDJSON stream

**Boundary: [`NdjsonStream`](../../../../infra/lambdas/ai/chat-orchestrator/stream.ts) -> calling client.** These are the complete HTTP response metadata fields configured by the streaming wrapper:

```json
{
  "statusCode": 200,
  "headers": {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  }
}
```

The complete event lines for this illustrated short run are:

```jsonl
{"type":"conversation","conversationId":"c4e7173b-3075-47b9-9e7d-260921bbc870","turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9"}
{"type":"activity","stage":"investigating"}
{"type":"activity","stage":"query_started","operation":"query_events","table":"waf_events"}
{"type":"activity","stage":"query_completed","operation":"query_events","table":"waf_events","rowsReturned":1}
{"type":"activity","stage":"investigating"}
{"type":"text_delta","text":"One blocked WAF request was returned: /login, Medium (severity_id 3), at 2026-09-11T23:45:15.000Z. "}
{"type":"text_delta","text":"Evidence: event_uid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; source_s3_key=raw/waf/2026-9-11.jsonl; source_record_ref=88888888-8888-4888-8888-888888888888. A WAF block alone does not prove exploitation."}
{"type":"complete","conversationId":"c4e7173b-3075-47b9-9e7d-260921bbc870","replayed":false,"truncated":false,"turnId":"296a0470-b7b7-4a21-a9d7-72fb7be90ac9"}
```

The first `conversation` line occurs after acceptance, not after the investigation finishes. The second `investigating` activity starts the post-result model call; it is not `finalizing` because tools remain enabled. This run finishes before the 15-second idle heartbeat is needed.

Concatenating the two `text_delta.text` values produces exactly the saved `ASSISTANT_MESSAGE.content`. Text may be delivered before that final write, but `complete` is attempted only after persistence succeeds. `replayed: false` means this is not a completed retry; `truncated: false` reflects the `end_turn` answer, separately from query-result truncation.

No SQL, raw tool arguments/results, prompt, or private-reasoning event is streamed. A broken connection can lose events without undoing durable completion; see [request/streaming](Request-and-Streaming.md#error-and-disconnect-semantics).

## Which representation is which?

| Representation | What identifies it | What it is not |
| --- | --- | --- |
| Parsed chat request | `conversationId`, `turnId`, `message` | Trusted identity or supplied history. |
| DynamoDB event | `PK`/`SK`, sequence, turn/attempt metadata, and variant payload | A Bedrock message or browser event. |
| Bedrock message | `role` and typed `content` blocks | A stored audit-item envelope. |
| Logical query | `operation` plus approved typed parameters | Model-authored SQL. |
| Query response | Safe execution metadata, columns, bounded rows, truncation | A persisted event until the store wraps it. |
| NDJSON event | `type` plus that event's public fields | A transcript of tool data or a separate token-level database write. |

This is the successful path, not an example of retries, compaction, cancellation, or failed persistence. Those transitions are covered in [persistence/context](Persistence-and-Context.md) and [agent/tools](Agent-Loop-and-Tools.md). Playbook retrieval, public frontend/API transport, and authenticated ownership/Stop remain unimplemented integrations.
