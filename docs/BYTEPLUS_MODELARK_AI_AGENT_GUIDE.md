# BytePlus ModelArk (`ap-southeast-1`) — AI Agent Architecture & Integration Guide

> **Status:** Active Reference Blueprint (Verified against official `docs.byteplus.com/en/docs/ModelArk` & POOLNET / RTrader codebase as of Phase DX)
> **Scope:** Stateless AI Advisory, 5-Agent Trading Desk, Verified KOL Consensus Context, Launchpad Multimodal Studio, and Offline Dataset Evaluation.

---

## 1. Non-Negotiable Architecture Boundaries (`AGENTS.md`)

All BytePlus ModelArk integrations MUST obey these platform invariants:
1. **Stateless Vercel Control Plane:** Every LLM or image call MUST be stateless, non-blocking, and guarded by strict timeouts (`<= 6s` fast / `<= 9s` deep) with deterministic fallback.
2. **PostgreSQL Neon SSOT:** Never move user state, positions, trade intents, or KOL profiles into BytePlus Managed Agent Sessions or Memory Stores. Neon PostgreSQL remains the sole operational source of truth.
3. **100% Non-Custodial Guarantee:** Never store user wallet private keys, seed phrases, or exchange API secrets in BytePlus Vaults (`/api/v3/vaults`). User BYOK keys stay encrypted in our local AES-256-GCM vault (`user_provider_api_keys`).
4. **Advisory-Only AI:** BytePlus ModelArk models NEVER bypass `packages/trading/risk-gate.ts`, Kill-Switch, or user SIWE/wallet signing.
5. **Zero PII / Zero Secrets in Prompts:** Only sanitized public market metrics, quantitative signals, and curated KOL consensus summaries may be sent to ModelArk.

---

## 2. Current Codebase Integration State

BytePlus ModelArk is already wired as the **Default Primary LLM Engine** (`AI_PRIMARY_PROVIDER=byteplus`):

| Component | File Path | Role |
| :--- | :--- | :--- |
| Unified LLM Advisory Client | `packages/intelligence/llm-advisory-client.ts` | Failover chain: `User BYOK (Gemini/OpenAI/Anthropic)` -> `BytePlus ModelArk` -> `Gemini` -> `Deterministic Fallback` |
| Provider Registry | `packages/providers/registry.ts` | Registers `BYTEPLUS` (`status: 'LIVE'`, default platform engine) |
| KOL Consensus & Backtest Engine | `packages/intelligence/kol-chart-overlay.ts` | 5 anti-manipulation guardrails, chart markers, curated dataset snapshot & win-rate backtest |
| AI Proposal Intelligence API | `app/api/agent/proposals/intelligence/route.ts` | Combines quantitative signal + `kolConsensus` + LLM advisory note |
| 5-Agent Trading Desk API | `app/api/agent/desk/run/route.ts` | Multi-agent advisory cycle with metered credit deduction |
| Scheduled Dataset Archive Cron | `app/api/cron/kol-consensus-archive/route.ts` | Daily `00:00 UTC` archive into `scraped_documents` (`domain = 'kol_consensus_archive'`) |

### Current Environment Variables (Supports Comma-Separated Free-Quota Waterfall)
```env
AI_PRIMARY_PROVIDER=byteplus
BYTEDANCE_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3
BYTEDANCE_ARK_API_KEY=<Project-scoped API key from BytePlus project "kripto">

# Comma-separated pool: auto-fails over to the next free-quota endpoint on HTTP 429/402/403
# Recommended Fast Pool: Dola-Seed-2.0-mini, Dola-Seed-2.0-lite, ByteDance-Seed-1.8, DeepSeek-V4.1-Flash-Economy
BYTEDANCE_MODEL_ENDPOINT=<ep-seed20-mini,ep-seed20-lite,ep-seed18,ep-deepseek-v41-flash-eco>

# Recommended Deep Pool: DeepSeek-V4-Pro-GA, Dola-Seed-2.1-turbo, Dola-Seed-2.0-pro
BYTEDANCE_DEEP_ENDPOINT=<ep-deepseek-v4-pro-ga,ep-dola-seed-21-turbo,ep-dola-seed-20-pro>

# Optional Launchpad Image Studio Pool: ByteDance-Seedream-4.5, Dola-Seedream-5.0-flash
BYTEDANCE_IMAGE_ENDPOINT=<ep-seedream-45,ep-seedream-50-flash>
```

---

## 3. BytePlus ModelArk (`ap-southeast-1`) Official API & Model Reference

- **Data Plane Base URL (`ap-southeast-1`):** `https://ark.ap-southeast.bytepluses.com/api/v3`
- **OpenAI SDK Compatible:** Supported (`base_url = https://ark.ap-southeast.bytepluses.com/api/v3`), passing ModelArk-specific params (e.g. `thinking`) in request body and MCP headers (`ark-beta-mcp: true`).

### Official Endpoints Relevant to POOLNET
| Capability | Method & Endpoint | Recommended Usage in POOLNET |
| :--- | :--- | :--- |
| **Chat Completions** | `POST /api/v3/chat/completions` | Fast & Deep structured JSON advisory (`llm-advisory-client.ts`) |
| **Responses API** | `POST /api/v3/responses` | Explicit Context Caching (`caching`, `prompt_cache_key`) & Remote MCP calls |
| **Image Generation** | `POST /api/v3/images/generations` | Launchpad Creator Asset Studio (Token Logo & Banner AI generation) |
| **Multimodal Embeddings** | `POST /api/v3/embeddings/multimodal` | Future semantic similarity over token narratives & whitepapers |
| **Info Quest MCP** | `https://mcp.infoquest.bytepluses.com/mcp` | Real-time crypto news & web catalyst search (`ark-beta-mcp: true`) |
| **Batch Inference** | `CreateBatchInferenceJob` / Batch Chat | Offline evaluation of archived `kol_consensus_archive` datasets (>=50% discount) |

### Recommended Specialist Model Routing (Maximizing 500K Free Quota per Model)
| POOLNET Workload | BytePlus Model | Mode & Config | Why |
| :--- | :--- | :--- | :--- |
| **Primary Agent & Proposals** | `ByteDance-Seed-1.8` | `thinking: { type: "disabled" }` + `json_schema` | Low-latency agentic reasoning & reliable structured JSON in `ap-southeast-1` |
| **5-Agent Desk Deep Mode** | `DeepSeek-V3` / `DeepSeek-R1` | `thinking: { type: "enabled" }` (returns `reasoning_content`) | Deep risk/reward & TP/SL scenario synthesis + secondary failover before Gemini |
| **Launchpad Asset Studio** | `ByteDance-Seedream-4.5` or `Dola-Seedream-5.0-flash` | `/api/v3/images/generations` | Instant HD token logo & promotional banner generation with SVG fallback |
| **Bilingual (`EN`/`ID`) Output** | Native in `ByteDance-Seed-1.8` | `locale` directive in system prompt | Zero extra latency vs separate translation call |

> **Avoid in Serverless Paths:** Video generation (`Seedance-1.0-pro`) has multi-second/minute latency unsuitable for synchronous Vercel API routes.

---

## 4. BytePlus IAM Project `kripto` Security Checklist

When provisioning resources under BytePlus IAM Project **`kripto`** (`ap-southeast-1`):
1. **Project Isolation:** Create all POOLNET inference endpoints inside project **`kripto`** (not `default`).
2. **Project-Scoped API Key:** Generate a dedicated API key scoped to project `kripto` and enable **Model/Endpoint ID Allowlist** so the key can only invoke authorized POOLNET endpoints.
3. **Content Filter ON:** Keep BytePlus ModelArk **Content Filter** enabled on all online inference endpoints.
4. **Vercel Sensitive Storage:** Store `BYTEDANCE_ARK_API_KEY` as an **Encrypted / Sensitive** environment variable separately on `rtrader-testnet` and `rtrader-production`. Never commit keys to `.env` or git.

---

## 5. Phased Implementation Roadmap (Ready for Strict Audit-First Execution)

### Phase DY — KOL-Aware Bilingual Advisory, Strict `json_schema` & Deep Thinking Toggle
- **Target Files:** `packages/intelligence/llm-advisory-client.ts`, `app/api/agent/proposals/intelligence/route.ts`, `app/api/agent/desk/run/route.ts`, `app/agent/page.tsx`
- **Deliverables:**
  1. Inject sanitized `kolConsensus` (`score`, `uniqueVerifiedKols`, `skinInTheGameCount`, `verdict`, `flags`) into `buildSanitizedAdvisoryPrompt()`.
  2. Upgrade BytePlus request to strict `json_schema` response format + `thinking: { type: 'disabled' | 'enabled' }` control (`fast` vs `deep` mode) with optional `reasoningSummary`.
  3. Add bilingual `locale: 'en' | 'id'` prompt directive so advisory notes match UI language.
  4. Support optional `BYTEDANCE_DEEP_ENDPOINT` (`DeepSeek`) as deep-mode primary & automatic failover before Gemini.
  5. Add Unit Suite covering prompt sanitization, `kolConsensus` inclusion, `thinking` toggle, and fallback behavior.

### Phase DZ — Launchpad Creator Asset Studio (`ByteDance-Seedream-4.5`)
- **Target Files:** `packages/launchpad/` (asset generator helper), Launchpad Studio API & UI
- **Deliverables:**
  1. Non-blocking client for `POST /api/v3/images/generations` using `BYTEDANCE_IMAGE_ENDPOINT` (`Seedream-4.5` / `Dola-Seedream-5.0-flash`).
  2. Strict prompt sanitization (blocks offensive/copyright/PII payloads) + metered credit check + automatic fallback to existing deterministic SVG generator when unconfigured or timed out.

### Phase EA — Info Quest MCP Catalyst Search, Context Caching & Batch Backtest
- **Target Files:** `packages/intelligence/llm-advisory-client.ts`, `app/api/cron/agent-scout-sync/route.ts`, `app/api/admin/kol-dataset/route.ts`
- **Deliverables:**
  1. Integrate BytePlus **Responses API** (`/api/v3/responses`) with explicit Context Caching (`prompt_cache_key`) for repeated 5-Agent Desk system prompts (50–80% input token savings).
  2. Optional **Info Quest MCP** (`https://mcp.infoquest.bytepluses.com/mcp`, `ark-beta-mcp: true`) as live crypto news/catalyst backup alongside `FirecrawlScraper`.
  3. JSONL exporter format on `/api/admin/kol-dataset?format=jsonl` ready for BytePlus **Batch Inference** offline evaluation of `kol_consensus_archive`.

---

## 6. Verification & Regression Commands

After implementing any phase above, always run the full verification matrix:
```powershell
# Local Typecheck + Unit + Whitebox + Simulation
bun run verify:all

# Live Testnet E2E, Adversarial Pentest & Dual-Environment Blackbox + UI Smoke
$env:NODE_OPTIONS='--dns-result-order=ipv4first'
bun run verify:testnet:e2e
bun run verify:adversarial
bun run verify:live:all
```
