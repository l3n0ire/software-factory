// Agent Relay wiring. Each office member is its own Relay agent with its own AgentRelay
// instance, so a listener only receives that agent's DMs. Tokens are persisted so a
// restarted brain reconnects as the same identities.
import fs from "node:fs"
import { AgentRelay } from "@agent-relay/sdk"
import { actors } from "../generated/index.js"
import { config, RELAY_TOKENS_FILE, STATE_DIR } from "./config"

/** "customer" or a roster agent id (e.g. "pm", "engineer", "ghoulia"). */
export type AgentName = string
export type MsgKind = "chat" | "ticket" | "spec" | "question" | "answer" | "review_request" | "changes" | "approved" | "shipped" | "failed"

export type Envelope = { ticketId: string; kind: MsgKind; body: string; from: string; messageId: string }
type Handler = (msg: Envelope) => Promise<void>

type AgentClient = Awaited<ReturnType<AgentRelay["workspace"]["reconnect"]>>

const clients = new Map<AgentName, AgentClient>()
const relays = new Map<AgentName, { relay: AgentRelay; unsubscribe: () => void }>()
const seen = new Set<string>()

function loadTokens(): Record<string, string> {
    try {
        return JSON.parse(fs.readFileSync(RELAY_TOKENS_FILE, "utf8"))
    } catch {
        return {}
    }
}

function saveToken(name: string, token: string) {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const all = loadTokens()
    all[name] = token
    fs.writeFileSync(RELAY_TOKENS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 })
}

/** Text format on the wire: "[T1 spec] human readable body". */
export function encode(ticketId: string, kind: MsgKind, body: string) {
    return `[${ticketId} ${kind}] ${body}`
}

export function decode(text: string): { ticketId: string; kind: MsgKind; body: string } | null {
    const m = text.match(/^\[(T\d+|chat) ([a-z_]+)\] ([\s\S]*)$/)
    return m ? { ticketId: m[1]!, kind: m[2] as MsgKind, body: m[3]! } : null
}

export async function connectAgent(name: AgentName, onMessage: Handler) {
    if (!config.relayWorkspaceKey) throw new Error("RELAY_WORKSPACE_KEY is not set (run scripts/start.sh, which creates a local workspace)")
    const relay = new AgentRelay({ workspaceKey: config.relayWorkspaceKey, baseUrl: config.relayBaseUrl })
    const token = loadTokens()[name]
    let client: AgentClient
    if (token) {
        client = await relay.workspace.reconnect({ apiToken: token })
    } else {
        client = (await relay.workspace.register({ name, type: "agent" })) as AgentClient
        saveToken(name, (client as unknown as { token: string }).token)
    }
    clients.set(name, client)
    const unsubscribe = relay.addListener("dm.received", async (e: any) => {
        const id: string = e.message?.messageId ?? e.message?.id
        if (!id || seen.has(id)) return
        seen.add(id)
        const parsed = decode(String(e.message?.text ?? ""))
        if (!parsed) return
        const from = String(e.envelope?.from?.name ?? "?")
        if (from === name) return
        if (!relays.has(name)) return // retired: this identity no longer takes work
        onMessage({ ...parsed, from, messageId: id }).catch(err => console.error(`[${name}] handler error`, err))
    })
    relays.set(name, { relay, unsubscribe })
    return client
}

/** Retire a Relay identity: stop listening, stop sending, and release it on the Relay server (best effort). */
export async function disconnectAgent(name: AgentName) {
    const r = relays.get(name)
    relays.delete(name)
    clients.delete(name)
    r?.unsubscribe()
    try {
        await r?.relay.workspace.release({ name, reason: "retired from the Software Factory" })
    } catch (e) {
        console.warn(`[relay] release ${name} failed (listener already removed):`, (e as Error).message)
    }
}

/** Send a DM over Agent Relay and mirror it into the Company event log for the office UI. */
export async function send(from: AgentName, to: AgentName, ticketId: string, kind: MsgKind, body: string) {
    const client = clients.get(from)
    if (!client) throw new Error(`relay agent ${from} not connected`)
    const sent = await client.sendMessage({ to: `@${to}`, text: encode(ticketId, kind, body) })
    await actors.Company.get(config.companyId).log({ ticketId: ticketId === "chat" ? null : ticketId, kind: "relay", from, to, text: `${kind}: ${body}`.slice(0, 2000) })
    console.log(`  [relay ${sent.messageId}] @${from} -> @${to} (${kind}): ${oneLine(body, 140)}`)
    return sent
}

export function oneLine(s: string, n = 120) {
    const t = s.replace(/\s+/g, " ").trim()
    return t.length > n ? t.slice(0, n - 1) + "…" : t
}
