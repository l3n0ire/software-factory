// OpenAI chat-completions client with tool calling. In MOCK mode the role code uses scripted
// responses instead (see roles.ts) so the pipeline runs without a key.
import { config, MOCK } from "./config"

export type ChatMessage =
    | { role: "system" | "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
    | { role: "tool"; tool_call_id: string; content: string }

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }

const PREFERRED = ["gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"]
let resolvedModel: string | null = null
/** Running token total for this brain process; a hard stop on spend regardless of how many tickets run. */
let tokensUsed = 0
export const tokenUsage = () => ({ used: tokensUsed, cap: config.maxTotalTokens })
export function resetTokens() { tokensUsed = 0 }

export async function resolveModel(): Promise<string> {
    if (MOCK) return "mock"
    if (resolvedModel) return resolvedModel
    if (config.openaiModel) return (resolvedModel = config.openaiModel)
    try {
        const res = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${config.openaiKey}` } })
        if (!res.ok) throw new Error(`models ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const ids = new Set(((await res.json()) as { data: { id: string }[] }).data.map(m => m.id))
        resolvedModel = PREFERRED.find(m => ids.has(m)) ?? "gpt-4o"
    } catch (e) {
        console.warn("[llm] could not list models, defaulting to gpt-4o:", (e as Error).message)
        resolvedModel = "gpt-4o"
    }
    return resolvedModel
}

export async function chat(messages: ChatMessage[], opts: { tools?: ToolDef[]; json?: boolean; maxTokens?: number } = {}) {
    const model = await resolveModel()
    if (tokensUsed >= config.maxTotalTokens) throw new Error(`token ceiling of ${config.maxTotalTokens} reached for this process (MAX_TOTAL_TOKENS)`)
    const body: Record<string, unknown> = { model, messages, max_completion_tokens: opts.maxTokens ?? config.maxCompletionTokens }
    // gpt-6-luna only allows function tools on chat completions when reasoning_effort is "none".
    if (opts.tools?.length) {
        body.tools = opts.tools
        body.reasoning_effort = "none"
    } else body.reasoning_effort = "low"
    if (opts.json) body.response_format = { type: "json_object" }
    for (let attempt = 1; ; attempt++) {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${config.openaiKey}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180_000),
        })
        if (res.ok) {
            const data = (await res.json()) as { choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[]; usage?: { total_tokens?: number } }
            tokensUsed += data.usage?.total_tokens ?? 0
            console.log(`[llm] ${model} tokens used so far: ${tokensUsed}/${config.maxTotalTokens}`)
            return data.choices[0]!.message
        }
        const text = await res.text()
        if (attempt >= 3 || (res.status < 500 && res.status !== 429)) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`)
        await Bun.sleep(2000 * attempt)
    }
}

export async function chatJson<T>(system: string, user: string): Promise<T> {
    const msg = await chat([{ role: "system", content: system }, { role: "user", content: user }], { json: true })
    const text = msg.content ?? "{}"
    try {
        return JSON.parse(text) as T
    } catch {
        const m = text.match(/\{[\s\S]*\}/)
        if (m) return JSON.parse(m[0]) as T
        throw new Error("model did not return JSON")
    }
}
