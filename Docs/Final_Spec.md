# AI Security Incident Response Copilot - Final Specification

_Final pre-implementation architecture and delivery plan._

**Status:** Proposed final MVP specification  
**Date:** 2026-09-23  
**Project duration:** Two semesters, approximately 40 weeks  
**Expected team size:** 4-6 students  
**Primary AWS Region:** `us-east-1`, unless a required Bedrock model is unavailable there

---

## 1. Project Summary

Build a serverless, read-only AI security incident response copilot for AWS-style investigations. An authenticated analyst uses a React chat application to investigate synthetic security incidents. The copilot maintains conversation context, selects read-only investigation tools, queries normalized security data through Athena, retrieves incident response playbooks, and returns evidence-backed summaries, timelines, confidence statements, and recommended next steps.

The project demonstrates:

- Cloud security and least-privilege IAM
- Incident response and threat investigation
- Security log normalization and data engineering
- Serverless application development
- Infrastructure as Code and CI/CD
- Retrieval-augmented generation
- Tool-using AI orchestration with Amazon Bedrock
- Ground-truth-based AI evaluation

The MVP is not a SIEM replacement and does not perform automatic remediation.

---

## 2. Authoritative Architecture Decisions

These decisions supersede conflicting statements in earlier planning documents.

| Area | MVP decision |
| --- | --- |
| Frontend | Vite, React, TypeScript, and TailwindCSS |
| Hosting | Private S3 website assets behind CloudFront using Origin Access Control |
| API | API Gateway with Lambda integrations |
| Authentication | Cognito-backed BFF authentication with opaque HttpOnly cookies and DynamoDB sessions |
| AI orchestration | Custom application-owned streaming tool loop using Amazon Bedrock `ConverseStream` |
| AI permissions | Read-only access to investigation data; no remediation tools or infrastructure write permissions |
| Conversation memory | DynamoDB-backed incident sessions, messages, summaries, and structured investigation state |
| RAG | Required for MVP; begin with a simple S3 playbook retriever behind a stable interface |
| Query engine | Athena over normalized Parquet data registered in the Glue Data Catalog |
| Data governance | Lake Formation governs the normalized data location and grants the query Lambda role `SELECT` and `DESCRIBE` access only |
| Transformation | AWS Glue ETL, for raw-to-normalized conversion |
| Initial load | Full 30-day backfill, processed independently by source type |
| Incremental load | On-demand initially; optional disabled-by-default daily Glue trigger |
| Schema | OCSF-aligned subset with source-specific tables, not a claim of complete OCSF compliance |
| Infrastructure | AWS CDK in TypeScript from the beginning |
| Deployment environments | `dev` and `demo` |
| Search | Athena only for MVP; OpenSearch is a stretch goal |
| Live vulnerable app | OWASP Juice Shop is a stretch goal only |
| MCP | MCP server is a stretch goal after the web application and tool contracts are stable |
| Budget | Hard limit of $100/month; target substantially below that amount |

---

## 3. Goals, Non-Goals, and Design Principles

### 3.1 Goals

The MVP must:

1. Ingest the prepared synthetic AWS-style datasets into S3.
2. Normalize raw data into query-efficient Parquet through Glue ETL.
3. Query CloudTrail, application, WAF, and VPC Flow-style evidence through Athena.
4. Support multi-turn investigations with persistent incident sessions.
5. Use Bedrock tool use to select bounded, read-only investigation operations.
6. Retrieve relevant response playbooks as part of the AI workflow.
7. Produce grounded answers with evidence references and explicit uncertainty.
8. Generate incident timelines and recommended human-reviewed next steps.
9. Evaluate results against hidden synthetic ground truth.
10. Demonstrate the complete system through a usable React interface.

### 3.2 Non-Goals

The MVP will not include:

- Automatic remediation or containment
- Arbitrary model-generated SQL
- Write access to the investigated environment
- A complete enterprise SIEM
- Full OCSF coverage for every event class
- Real-time streaming ingestion
- Multi-account AWS Organizations support
- Large-scale asset inventory
- Complex RBAC
- OpenSearch
- A live vulnerable workload
- A public MCP server

### 3.3 Design Principles

1. **Read-only investigation:** the application may write its own sessions, logs, and generated data, but it cannot modify investigated AWS resources.
2. **Evidence before conclusions:** important claims must identify the records that support them.
3. **Synthetic-data-first:** the final demo must succeed without any live attack infrastructure.
4. **Controlled tools:** models choose tools and parameters; application code validates parameters and constructs queries.
5. **Source separation:** different security sources retain distinct schemas and tables instead of being forced into one oversized table.
6. **Replaceable integrations:** model selection, retrieval implementation, and future MCP exposure sit behind stable interfaces.
7. **Cost visibility:** every recurring or usage-based service has limits, alarms, or an off switch.

---

## 4. MVP Scope and Synthetic Scenarios

### 4.1 Required Scenarios

#### Scenario A: Web Application Attack

An attacker probes and attacks a synthetic e-commerce application using SQL injection, XSS, CRLF injection, and sensitive-file access attempts.

Available evidence:

- Application request logs
- Corresponding WAF-style logs
- Corresponding VPC Flow-style records
- Successful and blocked requests
- Known attacker IP and geographic patterns

Expected analyst outcomes:

- Identify attack types and source IPs
- Distinguish blocked attempts from successful suspicious requests
- Correlate application, WAF, and network observations
- Build a timeline of probing and burst activity
- Recommend blocking, account review, endpoint review, and vulnerability remediation

#### Scenario B: Compromised AWS Credentials

An external actor performs console brute-force attempts, security scanning, and successful S3 enumeration/exfiltration behavior using AWS-style credentials.

Available evidence:

- Normal CloudTrail baseline activity
- Failed console login activity
- AccessDenied-heavy security scanner activity
- Successful S3 listing and exfiltration activity
- Distinct malicious source IPs

Expected analyst outcomes:

- Identify the compromised or abused identity
- Separate failed discovery attempts from successful access
- Find unusual source IP and user-agent behavior
- Build a sequence from access attempts through S3 activity
- Recommend credential rotation, policy review, log preservation, and scope analysis

### 4.2 Deferred Scenario

#### Scenario C: Suspicious Outbound Network Activity

This scenario remains a planned enhancement because the current VPC Flow dataset represents traffic associated with the web scenario rather than an independent outbound compromise.

Possible future evidence:

- Large outbound transfer from a workload
- Communication over an unusual destination port
- GuardDuty-style finding
- Route 53 Resolver query to a suspicious domain
- Related CloudTrail workload or role activity

This scenario should not delay completion of the two fully prepared MVP scenarios.

---

## 5. Prepared Dataset Inventory

### 5.1 Dataset Window

- Time range: September 1-30, 2026
- Organization: 30 daily files grouped into five week folders
- Raw data is retained as the source of truth
- Normalized data is generated and may be rebuilt

### 5.2 Application Dataset

- Approximately 5,650 events
- Approximately 1,000 malicious requests
- Remaining records represent normal e-commerce activity
- Attack types: SQL injection, XSS, CRLF injection, and sensitive-file access
- Ten selected XSS requests return HTTP 200 to represent potentially successful behavior
- Other generated malicious requests use 4xx responses unless intentionally overridden

Known synthetic attacker identities:

| Attack | Source IP | Location |
| --- | --- | --- |
| XSS | `200.51.100.10` | Ashburn, US, VA |
| CRLF | `200.51.100.14` | London, GB, ENG |
| SQL injection | `200.51.100.35` | New York, US, NY |
| Sensitive-file access | `200.51.100.13` | Toronto, CA, ON |

### 5.3 WAF Dataset

- One WAF-style JSON record per application request
- Normal requests generally produce `ALLOW`
- Blocked attacks produce `BLOCK`
- Selected successful XSS requests can produce an allowed or non-terminating match
- Request IDs, timestamps, client IPs, request paths, and parameters support correlation with application evidence

### 5.4 VPC Flow Dataset

- One AWS-style space-delimited flow record per generated WAF/application request
- Records represent client-to-ALB network reachability
- VPC action normally remains `ACCEPT` even when WAF blocks the HTTP request
- Daily files are an intentional MVP simplification over real delivery intervals
- A compact manifest documents generation assumptions; per-record manifest entries are optional

### 5.5 CloudTrail Dataset

- Approximately 2,500 baseline records
- 250 malicious or suspicious records
- Sources include normalized public datasets and synthetic baseline activity

Known synthetic attacker identities:

| Activity | Source IP |
| --- | --- |
| Console login brute force | `24.5.32.5` |
| AWS security scanner | `95.90.195.80` |
| S3 exfiltration | `203.0.113.77` |

### 5.6 Evaluation Leakage Rule

Synthetic generation labels must not be available to the AI during evaluation.

Fields such as these are ground-truth annotations rather than realistic analyst evidence:

- `is_malicious`
- `scenario_id`
- synthetic `confidence`
- synthetic `attack_category`
- labels that directly reveal the expected answer

The raw zone may retain those values for provenance, but Glue must either exclude them from analyst-facing tables or place them in a restricted evaluation dataset. Natural source evidence such as WAF rule matches, HTTP status, CloudTrail error codes, and observed payloads remains available because a real analyst would see it.

The AI runtime role must not have access to hidden ground-truth files.

---

## 6. High-Level Architecture

```text
Analyst browser
      |
      v
CloudFront
  |-- /*      -> private S3 frontend bucket
  |-- /api/*  -> API Gateway
      |
      v
Authentication and session boundary
  |-- Cognito
  |-- auth Lambda
  |-- DynamoDB auth sessions
      |
      v
Chat and investigation API
  |-- incident/session handlers
  |-- AI orchestration Lambda
      |
      v
Amazon Bedrock ConverseStream tool loop
  |-- query_cloudtrail
  |-- query_web_activity
  |-- query_network_activity
  |-- get_incident_playbook
      |
      +--------------------+
      |                    |
      v                    v
Athena query services   S3 playbook retriever
      |                    |
      v                    v
Lake Formation         S3 playbooks/index
      |
      v
Glue Data Catalog and normalized Parquet in S3
      ^
      |
Glue ETL jobs
      ^
      |
Raw synthetic data in S3
```

### 6.1 Full User Flow

1. CloudFront serves the React application from a private S3 origin.
2. The analyst logs in through the BFF authentication endpoint.
3. The auth Lambda authenticates with Cognito, creates an opaque session, stores its server-side state in DynamoDB, and returns a Secure HttpOnly cookie.
4. The analyst creates or opens an incident conversation.
5. The frontend sends a message with the incident identifier.
6. The backend validates the auth session and loads recent messages, a rolling summary, known entities, evidence references, and unresolved questions.
7. The orchestration Lambda calls Bedrock with tool definitions and the bounded conversation context.
8. If Bedrock requests a tool, application code validates the tool parameters and invokes the appropriate query or retrieval service.
9. Athena queries normalized Parquet using partition filters and controlled SQL templates. Lake Formation authorizes the query Lambda role against the requested database and tables before data is read.
10. Tool results return compact evidence objects rather than unbounded raw query output.
11. The orchestration loop returns tool results to Bedrock for synthesis.
12. The chat Lambda streams structured progress events and final answer deltas through API Gateway to the frontend.
13. The final answer distinguishes observed facts, inferences, uncertainty, and recommended next steps.
14. Messages, evidence references, structured incident state, usage metadata, and latency are saved to DynamoDB when the response completes.
15. The frontend renders streamed text, evidence, and timeline updates as they arrive.

---

## 7. Frontend Specification

### 7.1 Technology

- Vite
- React
- TypeScript
- TailwindCSS
- A small established component/icon library where helpful
- Unit tests for state and utility functions
- Browser-level tests for critical flows

### 7.2 Primary Layout

The application should resemble a focused AI investigation workspace rather than a marketing site.

```text
+------------------+---------------------------------------------+
| Sidebar          | Investigation header                        |
|                  +---------------------------------------------+
| New investigation| Message transcript                          |
| Incident history |                                             |
|                  | Evidence and timeline elements inline       |
| Settings/logout  |                                             |
|                  +---------------------------------------------+
|                  | Composer / send control                     |
+------------------+---------------------------------------------+
```

Required views and states:

- Login
- Investigation list/sidebar
- New investigation
- Multi-turn transcript
- Message composer
- Tool-running/loading indicator
- Evidence references
- Timeline rendering
- Empty state
- Authentication-expired state
- Recoverable error state
- Logout

The MVP does not require arbitrary user file uploads. Dataset ingestion remains an administrative/deployment workflow.

### 7.3 Hosting

- Frontend build artifacts live in a private S3 bucket.
- CloudFront uses Origin Access Control; the bucket is not public.
- SPA routes fall back to `index.html`.
- `/api/*` uses API Gateway as a second origin with caching disabled.
- API requests forward required headers, cookies, query strings, and response `Set-Cookie` values.
- Using one CloudFront hostname keeps browser cookies first-party and minimizes CORS complexity.

---

## 8. API and Authentication

### 8.1 API Style

Use a Regional API Gateway REST API with a streamed Lambda proxy integration for the chat route. The integration must use response transfer mode `STREAM` so Bedrock `ConverseStream` chunks pass through the chat Lambda and API Gateway without being buffered. Other routes may use ordinary buffered Lambda proxy responses.

The public API must not expose a general Glue transformation endpoint. Dataset backfills and administrative pipeline runs are deployment operations, not end-user actions.

### 8.2 Initial Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Authenticate and create an application session |
| `POST` | `/api/auth/logout` | Revoke the current session and clear its cookie |
| `GET` | `/api/me` | Return the authenticated user and session status |
| `GET` | `/api/incidents` | List the user's investigations |
| `POST` | `/api/incidents` | Create an investigation |
| `GET` | `/api/incidents/{incidentId}` | Return incident metadata and structured state |
| `GET` | `/api/incidents/{incidentId}/messages` | Return paginated messages |
| `POST` | `/api/incidents/{incidentId}/messages` | Submit an analyst message and stream the AI response |
| `GET` | `/api/incidents/{incidentId}/evidence/{evidenceId}` | Retrieve one authorized evidence item |
| `GET` | `/api/health` | Return a minimal application health response |

### 8.3 BFF Authentication

```text
Browser -> API Gateway -> auth Lambda -> Cognito
                              |
                              v
                       DynamoDB session
                              |
                              v
                   Secure HttpOnly cookie
```

Session requirements:

- Cryptographically random opaque session identifier
- Store only a hash of the session token when practical
- `Secure`, `HttpOnly`, and an appropriate `SameSite` cookie policy
- Short, configurable session lifetime
- DynamoDB TTL for automatic expiration
- Logout deletes or revokes server-side state
- Protected routes validate the server-side session
- Login errors do not reveal whether a username exists
- Rate-limit or throttle authentication attempts

The MVP uses one authenticated-user role. RBAC is deferred.

---

## 9. Backend Services

### 9.1 Lambda Responsibilities 

| Component | Responsibility |
| --- | --- |
| `auth-handler` | Login, logout, session creation, cookie handling |
| `session-authorizer` or shared auth middleware | Validate the opaque cookie against DynamoDB |
| `incident-handler` | Create and list incidents; return incident state and messages |
| `chat-handler` | Load context, run the Bedrock `ConverseStream` tool loop, stream events, and persist results |
| `query-cloudtrail` | Execute bounded identity/API activity queries |
| `query-web-activity` | Query and correlate application and WAF activity |
| `query-network-activity` | Query VPC Flow-style records and future network sources |
| `playbook-retriever` | Retrieve relevant Markdown sections through a stable interface |
| `evidence-handler` | Return one evidence item after authorization checks |

Transformation logic belongs to Glue ETL rather than an API Lambda.

### 9.2 Shared Application Utilities

Shared code should cover:

- AWS client construction
- Environment/configuration parsing
- Request and tool-input validation
- Athena execution and polling
- Controlled SQL generation
- Bedrock `ConverseStream` wrapper and stream-event encoder
- Tool dispatch
- Prompt loading
- Structured logging
- Correlation IDs
- Error normalization
- Evidence-object construction

Business logic should remain independently testable rather than being embedded directly in Lambda handlers.

---

## 10. AI Orchestration

### 10.1 Selected Approach

The MVP uses application-owned orchestration with Amazon Bedrock `ConverseStream` tool use. It does not depend on classic Bedrock Agents or AgentCore.

Bedrock returns a structured tool request, but application code executes the tool. This preserves validation, logging, least privilege, deterministic query construction, and debuggability.

```text
User message
    -> load bounded context
    -> ConverseStream request with tool definitions
    -> validate requested tool and parameters
    -> execute read-only tool
    -> return compact tool result to model
    -> repeat within configured limit
    -> generate final evidence-backed response
```

### 10.2 Orchestration Limits

The chat handler should enforce:

- Maximum tool iterations per response
- Maximum returned rows per tool
- Maximum tool-result byte size
- Mandatory time range for event queries
- Per-tool timeout
- Overall request timeout
- Model token limits
- Allowed model or inference-profile identifiers
- No unknown tools
- No tool arguments outside the declared schema

### 10.3 Response Contract

Final responses should contain:

- Concise finding summary
- Observed evidence
- Chronological timeline when appropriate
- Affected identities, IPs, resources, and endpoints
- Confidence level with rationale
- Missing evidence or alternative explanations
- Recommended investigation and containment actions
- Evidence identifiers that resolve to records available to the analyst

The model must distinguish:

- **Observed:** directly supported by evidence
- **Inferred:** a reasoned interpretation of evidence
- **Unknown:** unavailable or insufficient data

### 10.4 Model Configuration

- Store model or inference-profile ID in deployment configuration.
- Do not hard-code the model throughout application code.
- Use one model for the first complete vertical slice.
- Evaluate model alternatives only after tool and evaluation behavior is stable.
- Record model ID, request latency, token usage, tool calls, and errors without logging sensitive session cookies or credentials.

### 10.5 Streaming

Streaming is part of the MVP from the first end-to-end chat implementation. The chat path is:

```text
Bedrock ConverseStream
        |
        v
TypeScript chat-handler Lambda
        |
        v
API Gateway REST streaming integration
        |
        v
React fetch/ReadableStream client
```

The chat handler parses Bedrock stream events, executes validated tool requests, returns tool results to the model, and streams the final synthesis to the frontend. Tool-use turns may require multiple `ConverseStream` calls before final answer text is available.

The application stream should expose only user-facing events:

- `message_start`
- `tool_start`
- `tool_complete`
- `content_delta`
- `message_complete`
- `error`

Tool events may identify an operation such as querying CloudTrail or retrieving a playbook, but the application must not expose private model reasoning. The frontend incrementally renders `content_delta` events and finalizes the assistant message after `message_complete`.

The completed assistant response, evidence references, tool metadata, token usage, and latency are persisted after the stream finishes. Client disconnects and partial-stream failures must be logged and must not produce a falsely completed assistant message.

---

## 11. Persistent Conversation Memory

### 11.1 Storage Model

Use DynamoDB with separate logical records rather than storing an entire conversation in one growing item.

Suggested keys:

```text
PK = USER#{userId}
SK = INCIDENT#{incidentId}

PK = INCIDENT#{incidentId}
SK = META

PK = INCIDENT#{incidentId}
SK = MSG#{timestamp}#{messageId}

PK = INCIDENT#{incidentId}
SK = EVIDENCE#{evidenceId}
```

### 11.2 Context Strategy

Do not resend the entire transcript indefinitely. Build each Bedrock request from:

- System instructions
- Rolling incident summary
- Structured known entities
- Open questions and working hypothesis
- Most recent message window
- Relevant evidence references
- Current user message

When the recent-message window exceeds its configured threshold, summarize older turns and retain their evidence IDs. This reduces latency and token cost while preserving long-running diagnostic context.

### 11.3 Incident State

Each incident may track:

- Title and status
- Created and updated times
- Rolling summary
- Known users and roles
- Known source and destination IPs
- Known resources and endpoints
- Timeline events
- Evidence references
- Tools already called
- Open questions
- Current hypothesis
- Model/configuration version

---

## 12. RAG and Playbook Retrieval

RAG is part of the MVP.

### 12.1 Initial Retriever CheckThis

Store reviewed Markdown playbooks under `playbooks/` and maintain a small index containing:

- Document ID
- Title
- Incident categories
- Keywords
- Source and license
- Version
- S3 key
- Section headings

The `get_incident_playbook` tool accepts structured incident categories, indicators, and optional keywords. It returns a small number of relevant sections with document IDs and source metadata.

This is retrieval-augmented generation even though the first retriever is deterministic rather than vector-based.

### 12.2 Retrieval Interface

```json
{
  "incident_types": ["compromised_credentials"],
  "indicators": ["s3_exfiltration"],
  "limit": 3
}
```

The return contract must remain stable so the implementation can later migrate to Bedrock Knowledge Bases without changing the orchestration loop.

### 12.3 Future Migration

Bedrock Knowledge Bases may replace the simple retriever after the MVP works. S3 vector storage may be evaluated at that stage, but it is not an MVP dependency.

---

## 13. Security Data Lake

### 13.1 S3 Layout

```text
s3://security-copilot-data-{environment}-{account}/
|-- metadata/
|   |-- dataset_manifest.json
|   |-- README.md
|-- evaluation/
|   |-- ground_truth.json
|   |-- expected_timelines/
|-- raw/
|   |-- cloudtrail/
|   |-- app/
|   |-- waf/
|   |-- vpc-flow/
|   |-- guardduty/
|   |-- route53/
|-- normalized/
|   |-- cloudtrail/year=2026/month=09/day=01/
|   |-- app/year=2026/month=09/day=01/
|   |-- waf/year=2026/month=09/day=01/
|   |-- vpc-flow/year=2026/month=09/day=01/
|   |-- guardduty/year=2026/month=09/day=01/
|   |-- route53/year=2026/month=09/day=01/
|-- quarantine/
|   |-- cloudtrail/
|   |-- app/
|   |-- waf/
|   |-- vpc-flow/
|-- athena-results/
|-- playbooks/
```

GuardDuty and Route 53 prefixes are reserved but do not require populated MVP data.

### 13.2 Bucket Controls

- Block all public access
- Enforce TLS
- Default encryption
- Versioning for metadata and playbooks where useful
- Lifecycle expiration for Athena results and temporary transformation output
- Separate IAM access to raw, normalized, evaluation, and playbook prefixes
- Retain raw input; treat normalized and Athena result data as reproducible

### 13.3 Dataset Manifest

`dataset_manifest.json` should include:

- Dataset name and version
- Generated timestamp
- Time range
- Source types
- Raw and normalized prefixes
- File and record counts
- Format and schema version per source
- Partition layout
- Glue database and table names
- Severity-rule version
- Known simplifications
- Provenance and licensing notes
- Ground-truth location, without exposing ground-truth content to the runtime role

### 13.4 Lake Formation Governance

Register only the `normalized/` S3 prefix as a Lake Formation data location. The mixed-schema `raw/`, `quarantine/`, `evaluation/`, `playbooks/`, and `athena-results/` prefixes remain outside this registration and retain separate IAM and bucket-policy boundaries.

Use named-resource grants for the MVP because the normalized catalog contains a small, known set of tables. Grant the query Lambda execution role:

- `DESCRIBE` on the normalized Glue database and tables
- `SELECT` on the four populated normalized tables
- IAM permission for `lakeformation:GetDataAccess`, as required for Athena to obtain scoped temporary access to registered data

Do not grant the Bedrock model an AWS identity or data permissions. The model can request an approved tool, the orchestration Lambda can invoke that tool, and only the query Lambda execution role can reach Athena.

Remove the default `IAMAllowedPrincipals` access from the governed database and tables so broad IAM permissions do not bypass the intended Lake Formation grants. Do not introduce row filters, column filters, tag-based access control, or hybrid access mode unless a later requirement justifies their additional complexity.

---

## 14. Normalized Schema

### 14.1 Schema Strategy

Use an OCSF-aligned common envelope plus source-specific fields. Each source receives its own Glue/Athena table. Do not force CloudTrail, HTTP activity, WAF detections, and network flows into one table.

Common fields should include:

| Field | Purpose |
| --- | --- |
| `event_uid` | Stable normalized evidence identifier |
| `event_time` | UTC event timestamp |
| `source_type` | `cloudtrail`, `app`, `waf`, `vpc_flow`, and future sources |
| `activity_name` | Human-readable event or action |
| `activity_id` | Stable project-specific normalized activity value |
| `status` | `success`, `failure`, `allowed`, `blocked`, or `unknown` |
| `severity_id` | Numeric normalized severity |
| `severity` | Human-readable normalized severity |
| `severity_source` | Native severity or mapping rule used |
| `src_ip` | Source IP when present |
| `dst_ip` | Destination IP when present |
| `actor` | User, role, service, or session identity |
| `resource` | Affected AWS resource, URL, or application object |
| `request_id` | Native request/correlation identifier when present |
| `source_s3_key` | Raw object key used for traceability |
| `source_record_ref` | Source line or source-native record reference |
| `raw_event` | Optional serialized raw payload or safe subset |
| `schema_version` | Version of the normalized contract |

Source-specific columns remain available in the corresponding table.

### 14.2 Severity Mapping

Use the following common scale:

| ID | Label | Meaning |
| --- | --- | --- |
| 0 | Unknown | Insufficient information |
| 1 | Informational | Routine or contextual activity |
| 2 | Low | Weak anomaly or low-impact probe |
| 3 | Medium | Credible suspicious activity or blocked attack |
| 4 | High | Successful suspicious action or likely compromise |
| 5 | Critical | Confirmed high-impact compromise or exfiltration |

Rules must be deterministic, versioned, and documented in the dataset manifest. Examples:

- Routine successful baseline activity: Informational
- Repeated failed login or broad AccessDenied scanner behavior: Medium
- Blocked SQLi/XSS/CRLF/file-access request: Medium
- Allowed suspicious XSS request: High
- Successful suspicious S3 data access/exfiltration sequence: Critical

Severity is an analytical aid, not ground truth. The original status and native source fields must remain available.

---

## 15. Glue ETL Transformation Pipeline

### 15.1 Selected Design

Glue ETL performs raw-to-normalized transformation:

```text
Raw JSONL / text logs
        |
        v
Source-specific Glue ETL run
        |
        +--> validation failures -> quarantine prefix
        |
        v
Normalized Snappy Parquet
        |
        v
Glue Data Catalog tables
        |
        v
Lake Formation authorization
        |
        v
Athena
```

### 15.2 Job Structure

Use one shared Glue script package with source-specific transformer modules. Create separate job definitions or independently parameterized runs for:

- `normalize-cloudtrail`
- `normalize-app`
- `normalize-waf`
- `normalize-vpc-flow`

Example parameters:

```text
--source-type cloudtrail
--input-prefix s3://.../raw/cloudtrail/
--output-prefix s3://.../normalized/cloudtrail/
--quarantine-prefix s3://.../quarantine/cloudtrail/
--mode full
--schema-version 1
```

Each source is read independently. Different schemas must not be combined into one DynamicFrame before transformation.

### 15.3 Transformation Modules

```text
glue/
|-- job.py
|-- config.py
|-- schemas/
|   |-- common.py
|   |-- cloudtrail.py
|   |-- app.py
|   |-- waf.py
|   |-- vpc_flow.py
|-- transforms/
|   |-- cloudtrail.py
|   |-- app.py
|   |-- waf.py
|   |-- vpc_flow.py
|-- validation.py
|-- severity.py
```

Transformation logic should be written as testable functions wherever possible, with Glue/Spark setup kept at the job boundary.

### 15.4 Full Backfill

The first data load processes all 30 days for every populated source.

```text
Full backfill
|-- CloudTrail: all 30 days
|-- Application: all 30 days
|-- WAF: all 30 days
|-- VPC Flow: all 30 days
```

Backfill requirements:

- Write separate date partitions
- Use deterministic overwrite behavior for touched partitions
- Avoid duplicate output on rerun
- Record input, output, rejected, and error counts
- Fail when required-field or malformed-record thresholds are exceeded
- Preserve enough provenance to trace evidence to raw input

### 15.5 Incremental Processing

After the backfill:

- Use `--mode incremental`
- Process explicit pending date prefixes or use Glue job bookmarks
- Set maximum concurrent runs to one per source
- Use a short, bounded timeout
- Batch files rather than invoking one Spark job per S3 object

### 15.6 Scheduling

- Development default: on-demand only
- CDK may define a daily Glue scheduled trigger in a disabled state
- Enable recurring execution only while testing incremental ingestion
- Consider EventBridge Scheduler later if centralized scheduling, time zones, retries, or a DLQ are required

### 15.7 Catalog Strategy

Define the Glue database and normalized table schemas in CDK. Use Athena partition projection for the known date-based S3 layout. This avoids requiring a recurring crawler for every run.

A crawler may be used temporarily during schema exploration, but it is not the production MVP dependency and should not crawl the mixed-schema `raw/` root.

---

## 16. Athena Query Layer

### 16.1 Tables

Expected normalized tables:

- `cloudtrail_events`
- `application_events`
- `waf_events`
- `vpc_flow_events`
- Future: `guardduty_findings`
- Future: `route53_queries`

### 16.2 Query Safety CheckThis

The AI never submits SQL.

Tool Lambdas must:

- Accept typed filters
- Allowlist table and column names
- Use controlled SQL templates
- Require bounded time ranges
- Include date partition predicates
- Enforce a result limit
- Reject unsupported sort keys or operators
- Use a dedicated Athena workgroup
- Set a bytes-scanned cutoff per query
- Store results only in the controlled Athena results prefix
- Return compact evidence objects

Lake Formation is an authorization boundary, not a replacement for these query controls. A role with `SELECT` can still request all authorized rows, so time predicates, partition predicates, result limits, workgroup restrictions, and bytes-scanned limits remain mandatory.

### 16.3 Initial Tool Contracts

#### `query_cloudtrail`

Filters may include:

- Time range
- Source IP
- Username, ARN, principal, or role
- Event source
- Event name
- Error code
- Resource ARN
- Read-only or management-event status

#### `query_web_activity`

Filters may include:

- Time range
- Source IP
- HTTP method
- Path
- WAF action
- Status code
- WAF rule or match type
- Request ID

#### `query_network_activity`

Filters may include:

- Time range
- Source and destination IP
- Source and destination port
- Interface ID
- Protocol
- Action
- Minimum bytes or packets

#### `get_incident_playbook`

Filters may include:

- Incident categories
- Observed indicators
- Requested phase such as investigation, containment, or recovery
- Maximum sections

### 16.4 Evidence Contract

Every query tool should return a consistent envelope:

```json
{
  "query_summary": "Blocked web requests from the selected source IP",
  "truncated": false,
  "evidence": [
    {
      "evidence_id": "evt_...",
      "event_time": "2026-09-25T18:30:04Z",
      "source_type": "waf",
      "summary": "AWS WAF blocked a SQL injection match",
      "key_fields": {},
      "source_reference": {}
    }
  ]
}
```

---

## 17. Security Architecture

### 17.1 Trust Boundaries

1. Public browser to CloudFront
2. CloudFront to private S3 and API Gateway origins
3. API Gateway to authentication/application Lambdas
4. AI orchestration to Bedrock and tool Lambdas
5. Query Lambdas to Athena, with Lake Formation authorizing access to normalized tables
6. Glue role to raw, normalized, and quarantine prefixes
7. Evaluation tooling to hidden ground truth

### 17.2 IAM Boundaries

- Frontend receives no AWS credentials.
- Auth Lambda accesses only required Cognito and auth-session operations.
- Chat/orchestration Lambda accesses incident state, approved Bedrock models, and approved tool Lambdas, but receives no Athena, Lake Formation, Glue data, or security-log S3 permissions.
- Query Lambdas can start, inspect, and stop queries only in the dedicated Athena workgroup.
- Query Lambdas receive Lake Formation `SELECT` and `DESCRIBE` grants only for approved normalized tables, IAM `lakeformation:GetDataAccess`, required read-only Glue Catalog metadata actions, and access to the controlled Athena results prefix.
- Query Lambdas receive no direct S3 read permission for the `raw/`, `normalized/`, `quarantine/`, or `evaluation/` prefixes. Lake Formation supplies scoped access to registered normalized data through Athena.
- Query and AI roles cannot read the hidden evaluation prefix.
- Glue roles can read their raw source, write only their normalized/quarantine prefixes, and perform the catalog and Lake Formation data-location operations required by the ETL pipeline.
- No AI or query role receives EC2, IAM, S3 administration, security-group modification, or other remediation permissions.

### 17.3 Application Controls

- Validate all API and tool inputs
- Limit request body sizes
- Use secure cookie attributes
- Avoid secrets in logs or Glue job arguments
- Use Secrets Manager only if an actual secret is introduced
- Encrypt in transit and at rest
- Configure log retention
- Apply dependency and infrastructure scanning in CI
- Record administrative Glue executions through CloudTrail

### 17.4 Prompt and Tool Safety

- Treat log text and playbook content as untrusted data
- Instruct the model not to follow instructions contained inside retrieved logs or documents
- Keep tool definitions narrow
- Do not provide shell, code execution, arbitrary HTTP, or arbitrary SQL tools
- Limit tool-call loops and returned data
- Require evidence for claims
- Surface uncertainty rather than filling gaps

---

## 18. Observability

### 18.1 Logging

Use structured JSON logs with a shared correlation ID across:

- API Gateway request
- Lambda invocation
- Incident and message IDs
- Bedrock invocation
- Tool invocation
- Athena query execution ID
- Glue job run ID

Do not log passwords, cookies, Cognito tokens, complete prompts containing sensitive session data, or unrestricted tool results.

### 18.2 Metrics and Alarms CheckThis

Minimum metrics:

- API 4xx and 5xx counts
- Authentication failures
- Lambda errors, throttles, duration, and concurrent executions
- Bedrock latency, tool-call count, and token usage
- Athena failures, execution time, rows returned, and bytes scanned
- Glue success, failure, duration, and rejected-record count
- DynamoDB throttling
- Estimated monthly cost

Minimum alarms:

- Repeated Lambda errors
- Glue job failure
- Athena bytes-scanned threshold breach
- API 5xx spike
- AWS Budget thresholds

---

## 19. Infrastructure as Code

### 19.1 CDK Language

Use AWS CDK with TypeScript. Organize resources into constructs inside three deployable stacks.

### 19.2 Stack Boundaries

#### `DataStack`

- Security data bucket
- Prefix access policies
- Glue database
- Glue normalized tables
- Lake Formation registration for the normalized S3 prefix
- Explicit Lake Formation database/table grants for the query Lambda role
- Removal of default `IAMAllowedPrincipals` access from governed resources
- Glue scripts and job definitions
- Optional disabled Glue schedule
- Athena workgroup
- Athena results location and lifecycle rules
- Dataset metadata deployment

#### `AiStack`

- Chat orchestration Lambda
- Query Lambdas
- Playbook retriever
- Incident/session-state table or incident-specific records
- Bedrock invocation permissions and model configuration
- Tool definitions and prompt assets
- Relevant alarms and log groups

#### `FrontendApiStack`

- Frontend S3 bucket
- CloudFront distribution and OAC
- API Gateway
- Cognito user pool/client
- Auth-session table
- Auth and incident API handlers
- API integrations with AI services
- API access logs and alarms

Dependency direction:

```text
DataStack -> AiStack -> FrontendApiStack
```

Avoid reverse references and circular stack dependencies.

### 19.3 Resource Safety

- Use environment-qualified resource names
- Use termination protection for `demo`
- Retain stateful `demo` resources unless teardown is explicit
- Allow easier cleanup in `dev`
- Keep raw datasets and hidden evaluation data protected from accidental deletion
- Document teardown order and retained resources

---

## 20. CI/CD

### 20.1 Environments

- `dev`: active development and automated deployment
- `demo`: stable presentation environment with manual approval

### 20.2 GitHub Actions

Use GitHub OIDC federation rather than stored AWS access keys.

Pull request checks:

1. Install dependencies
2. Frontend lint, type-check, and test
3. Backend unit tests
4. Glue transformation unit tests
5. CDK tests
6. `cdk synth`
7. Security and dependency scanning

Deployment flow:

1. Merge to the development branch
2. Deploy infrastructure to `dev`
3. Build and upload frontend assets
4. Invalidate required CloudFront paths
5. Run smoke tests
6. Require approval before deploying the same reviewed revision to `demo`

### 20.3 Rollback

- Frontend: redeploy a known-good build artifact
- Lambda: redeploy a previous version/alias target
- Infrastructure: revert and redeploy the CDK change
- Data: retain raw input and rebuild normalized partitions
- Glue: version scripts and schema mappings; do not overwrite raw data

---

## 21. Cost Controls

Hard limit: **$100/month**. Operational target: substantially below the limit.

Controls:

- AWS Budget alerts at multiple thresholds
- On-demand Glue during early development
- Daily Glue schedule disabled by default
- One bounded batch per source instead of one Glue run per file
- Minimum practical Glue capacity and short timeout
- Maximum Glue concurrency of one per source
- Athena partition predicates and bytes-scanned limits
- Parquet with compression
- Short Athena-result lifecycle
- Bounded Bedrock context and output
- Rolling conversation summaries
- Configurable model choice
- Short development log retention
- No always-on EC2, containers, OpenSearch, or live vulnerable application in MVP
- Remove or disable demo-only resources after use

Illustrative Glue cost at the documented `$0.44` per DPU-hour rate:

```text
2 DPUs x 5 minutes x 30 daily runs x $0.44/DPU-hour
= approximately $2.20/month for one daily job
```

Actual pricing and duration vary by Region and configuration; the AWS Pricing Calculator and billing dashboard remain authoritative.

---

## 22. Evaluation Plan

### 22.1 Evaluation Dataset

Maintain a hidden ground-truth file for each scenario containing:

- Expected important events
- Expected entities
- Expected attack stages
- Expected timeline ordering
- Expected useful tools
- Acceptable alternative interpretations
- Unsupported conclusions that should not appear

The runtime application cannot access these files.

### 22.2 Evaluation Categories

| Category | Measurement |
| --- | --- |
| Tool selection | Did the system choose relevant tools and avoid unnecessary tools? |
| Evidence recall | Did it retrieve the important ground-truth events? |
| Citation validity | Does every evidence reference resolve to the claimed event? |
| Timeline accuracy | Are events ordered and described correctly? |
| Correlation | Does it connect related identity, web, WAF, and network activity appropriately? |
| Grounding | Does it avoid unsupported claims? |
| Uncertainty | Does it identify missing or ambiguous evidence? |
| Analyst usefulness | Are findings and next steps clear and actionable? |
| Latency | Is the interaction usable during the demo? |
| Cost | Does the workload remain within the project budget? |

### 22.3 Initial Acceptance Targets

- 100% of displayed evidence IDs resolve to stored records
- No infrastructure-changing tool or permission exists
- No hidden ground-truth field is queryable by the AI
- At least 90% of designated key events are found across the curated evaluation prompts
- No critical unsupported conclusion in final scenario responses
- Correct chronological ordering of designated timeline events
- Predefined demo prompts complete within the measured interaction budget established during performance testing
- Monthly projected cost remains below $100

### 22.4 Test Prompt Set

Include prompts that test:

- Broad triage
- Follow-up questions using prior context
- Specific IP investigation
- Specific identity investigation
- Timeline generation
- Cross-source correlation
- Playbook retrieval
- Questions unsupported by available data
- Attempts to persuade the model to execute remediation
- Prompt injection text embedded inside log fields

---

## 23. Implementation Plan

The project should be built in vertical slices so each phase leaves behind a demonstrable, tested capability.

### Phase 0: Repository and Engineering Foundation

Deliverables:

- Monorepo structure
- CDK application with environment configuration
- Frontend and backend package setup
- Formatting, linting, tests, and pre-commit conventions
- GitHub Actions pull-request checks
- AWS OIDC deployment role
- Budget and cost alarms

Exit criteria:

- Empty stacks synthesize successfully
- CI runs without long-lived AWS credentials

### Phase 1: Data Lake and One-Source Vertical Slice

Start with application logs because the web scenario is the highest-priority demo.

Deliverables:

- Data bucket and final prefix layout
- Dataset manifest
- Glue database and `application_events` table
- Lake Formation registration and least-privilege grants for `application_events`
- Application Glue transformer
- Full application backfill
- Athena query proving partition pruning and expected counts
- Quarantine and transformation metrics

Exit criteria:

- One raw source is transformed into partitioned Parquet and queried successfully
- The query succeeds through the authorized query Lambda role and is denied to an ungranted role
- Rerunning the backfill does not duplicate output

### Phase 2: Complete Data Pipeline

Deliverables:

- WAF transformer and table
- VPC Flow transformer and table
- CloudTrail transformer and table
- Full 30-day backfill for all sources
- Source-level validation reports
- Hidden evaluation dataset separated from runtime data

Exit criteria:

- Expected record counts reconcile from raw to normalized output
- Athena can query each source independently

### Phase 3: Controlled Investigation Tools

Deliverables:

- Athena helper library
- Typed query contracts
- CloudTrail, web, and network query tools
- Evidence envelope
- Query limits and bytes-scanned controls
- Unit and integration tests

Exit criteria:

- Each tool returns expected evidence for known scenario filters
- Invalid or unbounded requests are rejected

### Phase 4: Bedrock Orchestration and RAG

Deliverables:

- `ConverseStream` tool loop and stream-event protocol
- Tool dispatcher and loop limits
- System prompt and response contract
- S3 playbook index and retriever
- Evidence-backed final synthesis
- Usage and latency logging

Exit criteria:

- A command-line or test harness can complete both scenario investigations without the frontend

### Phase 5: Persistent Sessions and Authentication

Deliverables:

- Cognito BFF authentication
- Opaque DynamoDB-backed sessions
- Incident/message/evidence storage
- Rolling conversation summary
- Multi-turn context assembly
- Protected API routes

Exit criteria:

- Closing and reopening the browser preserves the authenticated session until expiration
- An investigation can continue across multiple messages and page reloads

### Phase 6: Frontend Experience

Deliverables:

- Login view
- Sidebar and incident history
- Chat transcript and composer
- Evidence and timeline components
- Loading, error, empty, and expired-session states
- Responsive desktop/mobile behavior

Exit criteria:

- The complete investigation can be performed through the hosted UI

### Phase 7: Evaluation and Hardening

Deliverables:

- Ground-truth evaluation harness
- Curated prompt set
- Tool and response metrics
- Prompt-injection and authorization tests
- Performance measurements
- Cost report
- Demo runbook

Exit criteria:

- Both required scenarios meet the acceptance criteria
- Known limitations are documented

### Phase 8: Demo and Final Deliverables

Deliverables:

- Stable `demo` environment
- Architecture diagram
- Final report
- Presentation
- Recorded or rehearsed demo path
- Teardown and recovery documentation

---

## 24. Testing Strategy

### Unit Tests

- Source-specific transformation mappings
- Severity rules
- Required-field validation
- Query filter validation
- SQL template generation
- Tool dispatch
- Context-window construction
- Rolling summary behavior
- Authentication cookie and session utilities

### Integration Tests

- Glue sample input to expected normalized output
- Athena query against deployed sample partitions
- Query Lambda to Athena
- Lake Formation authorized and unauthorized table-access checks
- Chat handler to mocked and live Bedrock development model
- Auth flow through API Gateway and Cognito
- DynamoDB persistence and pagination

### End-to-End Tests

- Login
- Create investigation
- Ask initial triage question
- Ask context-dependent follow-up
- Open evidence item
- Reload and resume conversation
- Logout

### Security Tests

- Unauthenticated route access
- Expired and forged session cookies
- Cross-user incident access
- SQL-like tool arguments
- Oversized tool parameters
- Prompt injection inside logs/playbooks
- Attempts to request remediation
- Verification that AI roles cannot access `evaluation/`
- Verification that orchestration and ungranted roles cannot query normalized tables or directly read normalized S3 objects

---

## 25. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| AI fabricates conclusions | Require evidence IDs, evaluate against ground truth, and instruct explicit uncertainty |
| AI generates unsafe queries | Do not accept SQL; validate structured parameters and use templates |
| Long conversations become slow or expensive | Recent-message window, rolling summary, structured state, and bounded evidence |
| Athena scans excessive data | Parquet, date partitions, mandatory predicates, workgroup cutoff |
| Glue cost grows through frequent runs | On-demand default, daily batching, disabled schedule, short timeout |
| Glue schema inference is unstable | Separate source reads and explicit normalized schemas |
| Synthetic labels leak answers | Exclude labels from runtime tables and deny evaluation-prefix access |
| VPC and WAF records are over-correlated | Preserve source semantics and use only defensible time/IP/request correlations |
| BFF implementation delays core AI work | Reuse proven prior Cognito/DynamoDB patterns and build the data/tool vertical slice first |
| Bedrock/model behavior changes | Stable tool contracts, model configuration, automated evaluation set |
| Team scope expands | Treat OpenSearch, live Juice Shop, AgentCore, Knowledge Bases, and MCP as post-MVP |
| API response latency harms UX | Use `ConverseStream` through a REST streaming integration, display tool progress, and measure time to first byte and total completion time |

---

## 26. Stretch Goals

Attempt only after all MVP definition-of-done items pass.

Priority order:

1. Bedrock Knowledge Base behind the existing retriever interface
2. Independent suspicious outbound network scenario
3. MCP server exposing the stable read-only investigation tools
4. OpenSearch for selected full-text application searches
5. OWASP Juice Shop live validation environment
6. Automated AWS asset context
7. External IOC enrichment
8. AgentCore evaluation
9. Human approval workflow for recommended actions

Any live vulnerable environment must be isolated, temporary, monitored, and torn down after use.

---

## 27. MVP Definition of Done

The MVP is complete when:

1. The React application is hosted through CloudFront from a private S3 origin.
2. A user can authenticate through the Cognito BFF flow.
3. Incident sessions and conversations persist across page reloads.
4. Glue transforms all prepared raw sources into date-partitioned Parquet.
5. Glue/Athena tables query the complete 30-day dataset.
6. The AI can use controlled CloudTrail, web, network, and playbook tools.
7. The AI completes both required synthetic scenarios through multi-turn conversation.
8. Responses stream through `ConverseStream` and contain valid evidence references, timelines, uncertainty, and recommended next steps.
9. The AI cannot read hidden ground truth or modify AWS resources.
10. Evaluation results meet the agreed acceptance targets.
11. CDK deploys `dev` and `demo` environments.
12. CI validates code, infrastructure, and tests.
13. Monitoring, cost alarms, teardown guidance, and a demo runbook exist.
14. Monthly projected cost remains below $100.

---

## 28. Deferred Implementation Choices

These choices do not block the first vertical slice and should be resolved through small proofs of concept:

- Exact Bedrock model or inference profile
- Backend application runtime where existing reusable code does not decide it
- Final session duration and context-window thresholds
- Exact Glue worker configuration after measuring the backfill
- Whether the simple retriever is sufficient for the final demo or should migrate to Bedrock Knowledge Bases

Team ownership remains undecided until the course team is formed.

---

## 29. AWS Reference Notes

The following current AWS capabilities informed this specification:

- [Bedrock tool use](https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use.html): application code can execute model-requested tools and return results for synthesis.
- [Bedrock ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html): supported models can return streamed conversational responses.
- [API Gateway response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html): REST APIs can stream proxy integration responses for generative AI and long-running operations.
- [CloudFront Origin Access Control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html): OAC is the recommended way to restrict S3 origins.
- [Glue S3 connections](https://docs.aws.amazon.com/glue/latest/dg/aws-glue-programming-etl-connect-s3-home.html): Glue can read multiple S3 paths and supported formats.
- [Glue DynamicFrames](https://docs.aws.amazon.com/glue/latest/dg/aws-glue-api-crawler-pyspark-extensions-dynamic-frame.html): DynamicFrames can represent inconsistent source records and resolve type choices.
- [Glue scheduled triggers](https://docs.aws.amazon.com/glue/latest/dg/about-triggers.html): Glue jobs can run on demand, on schedules, or from events.
- [Athena partition projection](https://docs.aws.amazon.com/athena/latest/ug/partition-projection-setting-up.html): known partition layouts can be projected without repeatedly adding catalog partitions.
- [Lake Formation underlying data access](https://docs.aws.amazon.com/lake-formation/latest/dg/access-control-underlying-data.html): integrated services such as Athena receive temporary access to registered data after Lake Formation authorization.
- [Lake Formation permissions reference](https://docs.aws.amazon.com/lake-formation/latest/dg/lf-permissions-reference.html): `SELECT` controls table queries and `DESCRIBE` controls metadata visibility.
- [Lake Formation metadata permissions](https://docs.aws.amazon.com/lake-formation/latest/dg/metadata-permissions.html): default `IAMAllowedPrincipals` access must be addressed when enforcing granular Lake Formation permissions.
- [Glue pricing](https://aws.amazon.com/glue/pricing/): ETL jobs are usage-based with a one-minute minimum billing duration.

---

## 30. First Build Milestone

After this specification is approved, the first implementation milestone is deliberately narrow:

> Deploy the `dev` data foundation, transform one day of application logs through Glue into partitioned Parquet, govern the normalized location and table with Lake Formation, query it through the authorized Lambda role with Athena, and verify expected record counts and access denial for an ungranted role through automated tests.

This proves the highest-risk new architectural choice before building the AI, authentication, or full frontend around it.
