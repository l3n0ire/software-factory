// Smoke test: call actor methods, read state, and watch the live socket stream.
import { actors } from "../generated/index.js"

const company = actors.Company.get("smoke")
console.log("boot count (persists across restarts):", await company.boot())
const t = actors.Ticket.get("smoke-ticket")
console.log("ticket create:", (await t.create({ ticketId: "S1", title: "smoke", description: "x", limits: { maxReviewRounds: 2, maxLlmCalls: 5, wallClockMs: 60_000 } })).state)

const { websocketUrl } = await actors.Company.prepareWebsocket({ actorId: "smoke", metadata: null })
console.log("ws url:", websocketUrl)
const ws = new WebSocket(websocketUrl)
ws.addEventListener("message", ({ data }) => console.log("SOCKET", String(data).slice(0, 300)))
await new Promise(r => ws.addEventListener("open", r, { once: true }))
await company.log({ ticketId: null, kind: "system", from: "smoke", to: null, text: "hello" })
await new Promise(r => setTimeout(r, 1000))
ws.close()
process.exit(0)
