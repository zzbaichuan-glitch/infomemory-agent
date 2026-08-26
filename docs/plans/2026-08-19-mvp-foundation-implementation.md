# InfoMemory MVP Foundation Implementation Plan

> Historical plan. The v0.2.0 implementation on `main` has since added Bearer
> authentication, metadata redaction, SQLite FTS5, reminders, Feishu outbound
> text, Docker/CI and the acceptance runner. Any earlier “not implemented” notes
> below describe the superseded milestone; see the [v0.2 design](2026-08-23-v0.2-secure-usability-design.md).

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Build the first runnable, security-first vertical slice for InfoMemory: ingest text, redact secrets, enforce tenant/user visibility, search evidence, generate citation-backed answers through an optional OpenAI-compatible gateway, and accept idempotent Feishu callbacks.

**Architecture:** Use an npm workspace with a framework-independent core package and a Fastify API application. Persist the pilot dataset with Node's built-in SQLite module so the first slice runs without Docker; isolate persistence behind repository interfaces so PostgreSQL/search infrastructure can replace it later. Treat LLM generation as an optional adapter: retrieval and source browsing continue to work when the gateway is disabled or unavailable.

**Tech Stack:** Node.js 24, TypeScript, npm workspaces, Fastify, Zod, Vitest, built-in `node:sqlite`, native `fetch`, PowerShell entry scripts.

---

## Execution constraints

- Branch: `codex/mvp-foundation`.
- Never persist or print the API key shared in chat. Use `.env.local`, which is ignored by Git, only after the exposed key is rotated.
- The product/repository identifier is `infomemory-agent`; the Chinese display name remains “知澜”.
- Do not claim vector search, source ACL synchronization, or full Feishu message ingestion in this slice; expose implemented capability names accurately.
- Commit after each independently passing task.

### Task 1: Bootstrap the TypeScript workspace

**Files:**

- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `scripts/dev.ps1`
- Create: `scripts/test.ps1`
- Create: `scripts/verify.ps1`

**Step 1: Define the workspace and scripts**

Set the root package to private, require Node 24+, and add workspace commands for `typecheck`, `test`, `build`, and `dev`. Add only the dependencies required by the first slice.

**Step 2: Define configuration examples safely**

Add `LLM_BASE_URL=https://llm-gw.bupt.edu.cn/v1`, a disabled-by-default model configuration, Feishu verification placeholders, and no real credentials. Ignore `.env`, `.env.local`, runtime databases, coverage, builds, and dependency folders.

**Step 3: Add explicit PowerShell entrypoints**

- `scripts/dev.ps1` calls `npm run dev --workspace @infomemory/api`.
- `scripts/test.ps1` calls `npm run test`.
- `scripts/verify.ps1` calls `npm run typecheck`, `npm run test`, and `npm run build` in sequence.

**Step 4: Install and validate dependency resolution**

Run: `npm install`

Expected: lockfile created with no install error.

**Step 5: Commit**

Run: `git add ... && git commit -m "chore: bootstrap TypeScript workspace"`

### Task 2: Implement secret-safe ingestion primitives

**Files:**

- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/domain.ts`
- Create: `packages/core/src/security/secret-redactor.ts`
- Test: `packages/core/test/secret-redactor.test.ts`

**Step 1: Write failing redaction tests**

Cover OpenAI-style keys, bearer tokens, password assignments, database URLs, ordinary non-secret text, multiple findings, and preservation of the last four characters as an optional fingerprint only.

**Step 2: Run the focused test**

Run: `npm run test --workspace @infomemory/core -- secret-redactor.test.ts`

Expected: FAIL because the redactor does not exist.

**Step 3: Implement minimal redaction**

Return `{ redactedText, findings }`; findings contain type, masked preview, and range, never the original secret. Ensure the function does not mutate input and deterministic patterns are evaluated without catastrophic backtracking.

**Step 4: Verify**

Run the focused test and `npm run typecheck --workspace @infomemory/core`.

Expected: PASS.

**Step 5: Commit**

Run: `git commit -m "feat(core): add secret-safe text redaction"`

### Task 3: Add tenant-safe asset persistence and retrieval

**Files:**

- Create: `packages/core/src/repositories/asset-repository.ts`
- Create: `packages/core/src/repositories/sqlite-asset-repository.ts`
- Create: `packages/core/src/services/asset-service.ts`
- Test: `packages/core/test/asset-service.test.ts`
- Test: `packages/core/test/sqlite-asset-repository.test.ts`

**Step 1: Write failing behavior tests**

Test idempotent ingestion, content-hash deduplication, public-within-tenant assets, owner-only assets, cross-tenant isolation, owner isolation, source metadata, and redacted storage.

**Step 2: Run focused tests**

Run: `npm run test --workspace @infomemory/core -- asset-service.test.ts sqlite-asset-repository.test.ts`

Expected: FAIL because repository and service are missing.

**Step 3: Implement repository boundary and SQLite adapter**

Create schema initialization and parameterized queries. Every read method must require an access context; do not expose an unscoped `findAll` API.

**Step 4: Implement asset service**

Validate input, redact before persistence, calculate SHA-256 content hash, enforce idempotency, and return safe asset metadata plus redacted content.

**Step 5: Verify and commit**

Run core typecheck and tests, then commit with `feat(core): add tenant-safe asset repository`.

### Task 4: Implement evidence search and optional LLM answers

**Files:**

- Create: `packages/core/src/services/search-service.ts`
- Create: `packages/core/src/services/answer-service.ts`
- Create: `packages/core/src/llm/openai-compatible-client.ts`
- Test: `packages/core/test/search-service.test.ts`
- Test: `packages/core/test/answer-service.test.ts`
- Test: `packages/core/test/openai-compatible-client.test.ts`

**Step 1: Write failing search tests**

Cover exact phrase ranking, token ranking, tenant/owner isolation inherited from the repository, empty queries, result limits, snippets, and stable citation IDs.

**Step 2: Implement deterministic keyword evidence search**

Label the returned mode `keyword`; do not describe it as hybrid/vector search. Produce source title, snippet, source location and score.

**Step 3: Write failing answer/client tests**

Test citation-backed fallback answers, refusal when no evidence exists, URL normalization to `/chat/completions`, request timeout, non-2xx responses, invalid provider payloads, and absence of API keys in thrown errors.

**Step 4: Implement the optional adapter and answer service**

The client accepts the key only through constructor configuration and sends a minimal evidence prompt. When disabled or failed, `AnswerService` returns evidence without fabricated prose and includes a machine-readable degradation reason.

**Step 5: Verify and commit**

Run all core tests and typecheck, then commit with `feat(core): add citation-backed search and answers`.

### Task 5: Expose the API and Feishu callback foundation

**Files:**

- Create: `apps/api/src/config.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/plugins/access-context.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/routes/assets.ts`
- Create: `apps/api/src/routes/search.ts`
- Create: `apps/api/src/routes/answers.ts`
- Create: `apps/api/src/routes/feishu-events.ts`
- Create: `apps/api/src/feishu/feishu-event-service.ts`
- Test: `apps/api/test/api.test.ts`
- Test: `apps/api/test/feishu-events.test.ts`

**Step 1: Write failing API tests with Fastify injection**

Cover health, required access headers, asset creation/listing, cross-tenant access, search, answer fallback, invalid request bodies, and safe error shapes.

**Step 2: Implement application composition**

Build the app through a factory that accepts database and LLM overrides for tests. Keep `server.ts` limited to environment loading, signal handling, listen, and sanitized startup logging.

**Step 3: Write Feishu callback tests**

Cover URL verification challenge, invalid verification token, unsupported event acknowledgement, duplicate event acknowledgement, and explicit inbound text normalization without storing unsupported message types.

**Step 4: Implement Feishu callback foundation**

Validate verification token, process `url_verification`, deduplicate by event ID, normalize the supported message event into the asset service, and acknowledge quickly. Do not implement outbound replies until Feishu app credentials and scopes are verified.

**Step 5: Verify and commit**

Run API tests, full typecheck, and build; commit with `feat(api): expose secure ingestion and Feishu callbacks`.

### Task 6: Document, verify, and push the milestone

**Files:**

- Create: `README.md`
- Create: `docs/architecture/mvp-foundation.md`
- Modify: `docs/plans/2026-08-19-information-memory-agent-prd.md`

**Step 1: Document capability truthfully**

Describe implemented endpoints, configuration, limitations, security decisions, local run flow, and the next milestones. Mark vector search, automatic source ACL sync, outbound Feishu replies, desktop UI, and production auth as not yet implemented.

**Step 2: Document the exact command/script call chain**

For each developer action list: user command → PowerShell entry script → npm workspace script → TypeScript entry/test runner. This satisfies the repository's recorded user preference.

**Step 3: Run full verification**

User command: `powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1`

Call chain: `scripts/verify.ps1` → root npm scripts → workspace `tsc`, `vitest run`, and build scripts.

Expected: all typechecks, tests, and builds pass; `git diff --check` returns no error; no tracked file matches secret patterns.

**Step 4: Commit and push**

Commit documentation, then run `git push -u origin codex/mvp-foundation`.

Expected: remote branch points to the verified commit. Do not push real `.env.local` or credentials.

