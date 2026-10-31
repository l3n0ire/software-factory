import path from "node:path"

export const ROOT = path.resolve(import.meta.dir, "..", "..")
export const DEMO_REPO = path.join(ROOT, "demo-repo")
export const WORKSPACES = path.join(ROOT, "workspaces")
export const UI_DIR = path.join(ROOT, "ui")
export const STATE_DIR = path.join(ROOT, ".state")
export const RELAY_TOKENS_FILE = path.join(STATE_DIR, "relay-agents.json")

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d)

export const config = {
    companyId: process.env.COMPANY_ID ?? "main",
    port: num(process.env.PORT, 4400),
    relayBaseUrl: process.env.RELAY_BASE_URL ?? "http://localhost:8787",
    relayWorkspaceKey: process.env.RELAY_WORKSPACE_KEY ?? "",
    openaiKey: process.env.OPENAI_API_KEY ?? "",
    openaiModel: process.env.OPENAI_MODEL ?? "",
    limits: {
        maxReviewRounds: num(process.env.MAX_REVIEW_ROUNDS, 2),
        maxLlmCalls: num(process.env.MAX_LLM_CALLS, 25),
        wallClockMs: num(process.env.TICKET_WALL_CLOCK_MS, 5 * 60_000),
    },
    maxEngineerSteps: num(process.env.MAX_ENGINEER_STEPS, 10),
    maxCompletionTokens: num(process.env.MAX_COMPLETION_TOKENS, 4000),
    maxTotalTokens: num(process.env.MAX_TOTAL_TOKENS, 300_000),
    testTimeoutMs: num(process.env.TEST_TIMEOUT_MS, 60_000),
}

export const MOCK = !config.openaiKey || process.env.MOCK_LLM === "1"
/** Pause used for walking animations so the office UI has time to show handoffs. */
export const PACE_MS = num(process.env.PACE_MS, MOCK ? 1400 : 500)

export const DEMO_TICKET = {
    title: "Add a GET /health endpoint",
    description:
        "Ops wants a health check for the Pumpkin Patch API. Add a GET /health endpoint that returns JSON {\"status\":\"ok\"} with HTTP 200, and add tests for it. Do not break existing routes.",
}
