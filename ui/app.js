// Office UI. All state comes from Terse actor WebSockets (Company, one Employee per agent, Ticket);
// the brain only hands out short-lived socket URLs and accepts new tickets.

const $ = s => document.querySelector(s)
const cfg = await fetch("/api/config").then(r => r.json())
const CID = cfg.companyId
$("#mode").textContent = cfg.mock ? "MOCK LLM (no OPENAI_API_KEY)" : `OpenAI ${cfg.model}`
$("#mode").className = "tag" + (cfg.mock ? " mock" : "")

// ---------------------------------------------------------------- actor sockets

const live = new Set()
function subscribe(actor, id, onState) {
  let state = {}
  let closed = false
  let ws
  const connect = async () => {
    try {
      const { url } = await fetch(`/api/socket?actor=${actor}&id=${encodeURIComponent(id)}`).then(r => r.json())
      ws = new WebSocket(url)
      ws.onopen = () => { live.add(`${actor}:${id}`); renderConn() }
      ws.onmessage = ev => {
        const m = JSON.parse(ev.data)
        if (m.state) state = m.state
        else if (m.changes) state = { ...state, ...m.changes }
        else return
        onState(state)
      }
      ws.onclose = () => { live.delete(`${actor}:${id}`); renderConn(); if (!closed) setTimeout(connect, 1500) }
    } catch { setTimeout(connect, 2000) }
  }
  connect()
  return () => { closed = true; ws?.close() }
}
function renderConn() {
  const ok = live.has(`Company:${CID}`)
  $("#conn").textContent = ok ? `live: ${live.size} actor sockets` : "actors offline, reconnecting…"
  $("#conn").className = "tag " + (ok ? "live" : "dead")
}

// ---------------------------------------------------------------- office scene

const cv = $("#office"), g = cv.getContext("2d")
const W = cv.width, H = cv.height
// Eight desk slots; the roster in the Company actor says who sits where.
const SLOTS = [
  { x: 150, y: 190 }, { x: 380, y: 190 }, { x: 610, y: 190 }, { x: 840, y: 190 },
  { x: 150, y: 400 }, { x: 380, y: 400 }, { x: 610, y: 400 }, { x: 840, y: 400 },
]
const ROLE_STYLE = {
  pm: { color: "#b78cff", label: "PM" },
  engineer: { color: "#6cc4ff", label: "Engineer" },
  reviewer: { color: "#ffd166", label: "Reviewer" },
}
const HAIR = ["#f28c28", "#3a2a2a", "#e8e8f0", "#7a3b1f", "#2d5a3d", "#b13a5a", "#1d1d3b", "#d8b04a"]
const SKIN = ["#ffd9b8", "#f1c7a0", "#e8b48a", "#c98d62", "#9b6a45", "#ffe0c8"]
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
const SPOTS = { whiteboard: { x: 115, y: 140 }, exit: { x: 325, y: 100 } }
const people = {} // agent id -> character
let roster = []

function deskOf(p) { return SLOTS[p.desk] ?? SLOTS[0] }
function spotPos(p, loc) {
  const d = deskOf(p)
  if (loc === "desk" || !loc) return { x: d.x, y: d.y + 95 }
  const other = people[loc]
  if (other && other !== p) { // visiting a colleague: stand beside their desk
    const od = deskOf(other), side = d.x < od.x ? -1 : d.x > od.x ? 1 : (d.y < od.y ? -1 : 1)
    return { x: od.x + side * 105, y: od.y + 65 }
  }
  return SPOTS[loc] ?? { x: d.x, y: d.y + 95 }
}

function syncRoster(list) {
  roster = list
  for (const r of list) {
    const p = people[r.id]
    if (r.status === "active" && !p) {
      const h = hash(r.name)
      const ch = { id: r.id, name: r.name, role: r.role, persona: r.persona, desk: r.desk, status: "idle", task: "", stats: {}, notes: [], bubble: null, toolBubble: null,
        hair: HAIR[h % HAIR.length], skin: SKIN[(h >> 3) % SKIN.length], alpha: 1, retired: false }
      const start = r.hiredAt && Date.now() - r.hiredAt < 15000 ? SPOTS.exit : spotPos(ch, "desk") // new hires walk in through the door
      Object.assign(ch, { x: start.x, y: start.y }); const t = spotPos(ch, "desk"); ch.tx = t.x; ch.ty = t.y
      people[r.id] = ch
      ch.unsub = subscribe("Employee", `${CID}-${r.id}`, s => {
        ch.status = s.status; ch.task = s.currentTask; ch.stats = s.stats; ch.notes = s.notes
        if (JSON.stringify(s.chat ?? []) !== JSON.stringify(ch.chat ?? [])) { ch.chat = s.chat ?? []; renderChat() }
        if (s.status === "retired") { ch.retired = true; ch.tx = SPOTS.exit.x; ch.ty = SPOTS.exit.y; return }
        const pos = spotPos(ch, s.location); ch.tx = pos.x; ch.ty = pos.y
      })
    } else if (p && r.status === "retired" && !p.retired) {
      p.retired = true; p.task = ""; p.tx = SPOTS.exit.x; p.ty = SPOTS.exit.y
    } else if (p && r.status === "active") p.desk = r.desk
  }
  renderRoster()
}

function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r) }

function drawRoom(t) {
  // floor
  g.fillStyle = "#4a3550"; g.fillRect(0, 0, W, H)
  for (let y = 90; y < H; y += 40) for (let x = 0; x < W; x += 80) {
    g.fillStyle = ((x / 80 + y / 40) % 2 === 0) ? "#5a4160" : "#553c5b"
    g.fillRect(x + ((y / 40) % 2) * 40 - 40, y, 80, 40)
  }
  // back wall
  g.fillStyle = "#2b2036"; g.fillRect(0, 0, W, 90)
  g.fillStyle = "#3a2b48"; g.fillRect(0, 84, W, 8)
  // window with moon
  rr(420, 14, 160, 60, 8); g.fillStyle = "#16233d"; g.fill()
  g.fillStyle = "#fff6c9"; g.beginPath(); g.arc(540, 40, 16, 0, 7); g.fill()
  g.fillStyle = "#16233d"; g.beginPath(); g.arc(533, 35, 14, 0, 7); g.fill()
  g.strokeStyle = "#3a2b48"; g.lineWidth = 4; g.strokeRect(420, 14, 160, 60); g.beginPath(); g.moveTo(500, 14); g.lineTo(500, 74); g.stroke()
  // bats
  for (let i = 0; i < 3; i++) {
    const bx = 440 + ((t / 30 + i * 47) % 130), by = 30 + Math.sin(t / 300 + i) * 8
    g.fillStyle = "#0a0a12"; g.beginPath(); g.ellipse(bx, by, 4, 3, 0, 0, 7); g.fill()
    const f = Math.sin(t / 60 + i) * 4
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx - 9, by - 3 - f); g.lineTo(bx - 4, by + 2); g.fill()
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + 9, by - 3 - f); g.lineTo(bx + 4, by + 2); g.fill()
  }
  // banner
  g.fillStyle = "#ff8a3d"; g.font = "600 20px Fredoka"; g.textAlign = "left"; g.fillText("SOFTWARE FACTORY · est. Halloween", 640, 52)
  // whiteboard
  rr(40, 18, 150, 66, 6); g.fillStyle = "#f4f1f8"; g.fill(); g.strokeStyle = "#8a7a99"; g.lineWidth = 3; g.stroke()
  g.fillStyle = "#5b4a77"; g.font = "500 12px Fredoka"; g.fillText("SPEC  →  CODE", 70, 44); g.fillText("→ REVIEW → SHIP", 66, 64)
  // door (new hires walk in here, retired agents walk out)
  rr(300, 22, 50, 70, 6); g.fillStyle = "#6b4a2f"; g.fill()
  g.fillStyle = "#ffd166"; g.beginPath(); g.arc(340, 60, 3, 0, 7); g.fill()
  g.fillStyle = "#f6eefc"; g.font = "600 10px Fredoka"; g.textAlign = "center"; g.fillText("EXIT", 325, 18)
  // pumpkins & plant
  pumpkin(60, 540, 1, t); pumpkin(950, 560, .8, t); pumpkin(330, 560, .7, t)
  // cobweb
  g.strokeStyle = "rgba(255,255,255,.25)"; g.lineWidth = 1
  for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(i * .35) * 70, Math.sin(i * .35) * 70); g.stroke() }
  for (let r = 18; r < 70; r += 16) { g.beginPath(); g.arc(0, 0, r, 0, Math.PI / 2); g.stroke() }
}

function pumpkin(x, y, s, t) {
  g.save(); g.translate(x, y); g.scale(s, s)
  g.fillStyle = "#ff8a3d"
  for (const dx of [-14, 0, 14]) { g.beginPath(); g.ellipse(dx, 0, 16, 20, 0, 0, 7); g.fill() }
  g.fillStyle = "#3d7a3a"; g.fillRect(-3, -26, 6, 10)
  const glow = 0.6 + Math.sin(t / 400 + x) * 0.3
  g.fillStyle = `rgba(255,230,120,${glow})`
  g.beginPath(); g.moveTo(-12, -4); g.lineTo(-6, -10); g.lineTo(-2, -4); g.fill()
  g.beginPath(); g.moveTo(12, -4); g.lineTo(6, -10); g.lineTo(2, -4); g.fill()
  g.beginPath(); g.moveTo(-12, 6); g.lineTo(12, 6); g.lineTo(6, 12); g.lineTo(0, 8); g.lineTo(-6, 12); g.fill()
  g.restore()
}

function drawDesk(p, t) {
  const d = { ...deskOf(p), color: ROLE_STYLE[p.role].color, label: `${p.name} · ${ROLE_STYLE[p.role].label}` }
  // desk
  g.fillStyle = "rgba(0,0,0,.25)"; g.beginPath(); g.ellipse(d.x, d.y + 46, 85, 12, 0, 0, 7); g.fill()
  rr(d.x - 80, d.y - 10, 160, 50, 10); g.fillStyle = "#a8774f"; g.fill()
  rr(d.x - 80, d.y - 10, 160, 14, 10); g.fillStyle = "#c18e62"; g.fill()
  // monitor
  rr(d.x - 30, d.y - 52, 60, 42, 6); g.fillStyle = "#222"; g.fill()
  const on = p.status === "working" || p.status === "thinking"
  rr(d.x - 26, d.y - 48, 52, 32, 4); g.fillStyle = on ? d.color : "#3b3f55"; g.fill()
  if (on) { g.fillStyle = "rgba(0,0,0,.35)"; for (let i = 0; i < 4; i++) g.fillRect(d.x - 20, d.y - 44 + i * 7, 10 + ((t / 90 + i * 13) % 30), 3) }
  g.fillStyle = "#444"; g.fillRect(d.x - 4, d.y - 10, 8, 6)
  // name plate
  g.fillStyle = "#2b2036"; rr(d.x - 62, d.y + 18, 124, 18, 6); g.fill()
  g.fillStyle = "#f6eefc"; g.font = "500 12px Fredoka"; g.textAlign = "center"; g.fillText(d.label, d.x, d.y + 31)
}

function drawPerson(p, t) {
  const d = { ...deskOf(p), color: ROLE_STYLE[p.role].color, hair: p.hair, skin: p.skin }
  const moving = Math.hypot(p.tx - p.x, p.ty - p.y) > 1
  const bob = moving ? Math.abs(Math.sin(t / 90)) * 5 : Math.sin(t / 600 + d.x) * 1.5
  const x = p.x, y = p.y - bob
  g.save(); g.translate(x, y); g.globalAlpha = p.alpha
  if (p.id === focusAgent) { g.strokeStyle = "#ff8a3d"; g.lineWidth = 3; g.beginPath(); g.ellipse(0, 46 + bob, 28, 9, 0, 0, 7); g.stroke() }
  // shadow
  g.fillStyle = "rgba(0,0,0,.3)"; g.beginPath(); g.ellipse(0, 46 + bob, 20, 6, 0, 0, 7); g.fill()
  // legs
  const step = moving ? Math.sin(t / 90) * 6 : 0
  g.strokeStyle = "#2b2036"; g.lineWidth = 6; g.lineCap = "round"
  g.beginPath(); g.moveTo(-7, 28); g.lineTo(-7 + step, 42); g.stroke()
  g.beginPath(); g.moveTo(7, 28); g.lineTo(7 - step, 42); g.stroke()
  // body
  rr(-16, 2, 32, 32, 14); g.fillStyle = d.color; g.fill()
  // arms
  const wave = p.status === "working" ? Math.sin(t / 70) * 4 : 0
  g.strokeStyle = d.skin; g.lineWidth = 5
  g.beginPath(); g.moveTo(-15, 10); g.lineTo(-22, 22 + wave); g.stroke()
  g.beginPath(); g.moveTo(15, 10); g.lineTo(22, 22 - wave); g.stroke()
  // head
  g.fillStyle = d.skin; g.beginPath(); g.arc(0, -16, 22, 0, 7); g.fill()
  // hair
  g.fillStyle = d.hair; g.beginPath(); g.arc(0, -22, 22, Math.PI, 0); g.fill()
  if (p.role === "pm") { g.beginPath(); g.arc(18, -12, 7, 0, 7); g.fill() } // ponytail
  if (p.role === "reviewer") { g.strokeStyle = "#333"; g.lineWidth = 2; g.beginPath(); g.arc(-8, -14, 6, 0, 7); g.arc(8, -14, 6, 0, 7); g.stroke() } // glasses
  // face
  const blink = (Math.floor(t / 100) + d.x) % 40 === 0
  g.fillStyle = "#2b2036"
  const look = moving ? Math.sign(p.tx - p.x) * 3 : 0
  if (blink) { g.fillRect(-10 + look, -14, 6, 2); g.fillRect(4 + look, -14, 6, 2) }
  else { g.beginPath(); g.arc(-7 + look, -14, 3, 0, 7); g.arc(7 + look, -14, 3, 0, 7); g.fill() }
  g.fillStyle = "rgba(255,120,140,.5)"; g.beginPath(); g.arc(-13, -6, 4, 0, 7); g.arc(13, -6, 4, 0, 7); g.fill()
  g.strokeStyle = "#2b2036"; g.lineWidth = 2; g.beginPath()
  if (p.status === "waiting") { g.arc(0, -3, 3, 0, 7) } else { g.arc(0, -6, 5, 0.2, Math.PI - 0.2) }
  g.stroke()
  // status icon
  const icon = { thinking: "💭", working: "⌨️", waiting: "❓", walking: "", idle: "" }[p.status] ?? ""
  if (icon) { g.font = "20px serif"; g.textAlign = "center"; g.fillText(icon, 26, -38 + Math.sin(t / 200) * 2) }
  if (p.status === "idle" && !moving) { g.fillStyle = "rgba(255,255,255,.6)"; g.font = "600 12px Fredoka"; g.fillText("z", 22, -36 - (t / 50 % 10)) }
  g.restore()
}

function wrap(text, maxW, font) {
  g.font = font
  const words = text.split(/\s+/), lines = []
  let cur = ""
  for (const w of words) {
    const test = cur ? cur + " " + w : w
    if (g.measureText(test).width > maxW && cur) { lines.push(cur); cur = w } else cur = test
  }
  if (cur) lines.push(cur)
  return lines
}

function drawBubble(p, b, t, small) {
  const age = t - b.at
  if (age > b.ttl) return false
  const alpha = Math.min(1, age / 200, (b.ttl - age) / 400)
  const font = small ? "500 12px Fredoka" : "500 14px Fredoka"
  const maxW = small ? 200 : 260
  let lines = wrap(b.text, maxW, font)
  if (lines.length > (small ? 2 : 5)) { lines = lines.slice(0, small ? 2 : 5); lines[lines.length - 1] += " …" }
  const lh = small ? 15 : 18, padX = 12, padY = 9
  const w = Math.max(...lines.map(l => g.measureText(l).width)) + padX * 2 + (b.head ? 0 : 0)
  const headH = b.head ? 16 : 0
  const h = lines.length * lh + padY * 2 + headH
  let bx = p.x - w / 2, by = p.y - 70 - h - (small ? 0 : 0)
  if (small) { by = p.y + 52; }
  bx = Math.max(6, Math.min(W - w - 6, bx)); by = Math.max(6, by)
  g.save(); g.globalAlpha = alpha
  g.fillStyle = small ? "rgba(20,14,28,.85)" : "#fffaf2"
  rr(bx, by, w, h, 12); g.fill()
  if (!small) { g.strokeStyle = ROLE_STYLE[p.role].color; g.lineWidth = 3; g.stroke()
    g.beginPath(); g.moveTo(p.x - 8, by + h); g.lineTo(p.x, by + h + 12); g.lineTo(p.x + 8, by + h); g.fillStyle = "#fffaf2"; g.fill() }
  g.textAlign = "left"
  if (b.head) { g.font = "700 11px Fredoka"; g.fillStyle = "#9a5a20"; g.fillText(b.head, bx + padX, by + padY + 10) }
  g.font = font; g.fillStyle = small ? "#d9cce8" : "#2b2036"
  lines.forEach((l, i) => g.fillText(l, bx + padX, by + padY + headH + (i + 1) * lh - 4))
  g.restore()
  return true
}

let last = performance.now()
function frame(t) {
  const dt = Math.min(50, t - last); last = t
  for (const p of Object.values(people)) {
    const dx = p.tx - p.x, dy = p.ty - p.y, dist = Math.hypot(dx, dy)
    const speed = 0.32 * dt
    if (dist > speed) { p.x += dx / dist * speed; p.y += dy / dist * speed } else { p.x = p.tx; p.y = p.ty }
  }
  drawRoom(t)
  for (const [id, p] of Object.entries(people)) {
    if (p.retired && Math.hypot(p.tx - p.x, p.ty - p.y) < 2) { p.alpha -= dt / 600; if (p.alpha <= 0) { p.unsub?.(); delete people[id] } }
  }
  const order = Object.values(people).sort((a, b) => a.y - b.y)
  for (const p of order) if (!p.retired) drawDesk(p, t)
  for (const p of order) drawPerson(p, t)
  for (const p of order) if (p.toolBubble && !drawBubble(p, p.toolBubble, t, true)) p.toolBubble = null
  for (const p of order) if (p.bubble && !drawBubble(p, p.bubble, t, false)) p.bubble = null
  // task captions
  g.textAlign = "center"; g.font = "500 11px Fredoka"; g.fillStyle = "rgba(246,238,252,.75)"
  for (const p of order) if (p.task && !p.retired) { const d = deskOf(p); g.fillText(p.task.slice(0, 40), d.x, d.y + 52) }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// Click a character to select it in the roster (where Replace lives).
let focusAgent = null
cv.addEventListener("click", ev => {
  const r = cv.getBoundingClientRect(), x = (ev.clientX - r.left) * W / r.width, y = (ev.clientY - r.top) * H / r.height
  const hit = Object.values(people).filter(p => !p.retired).find(p => Math.abs(p.x - x) < 30 && y > p.y - 45 && y < p.y + 50)
  if (hit) { focusAgent = hit.id; chatTargets = new Set([hit.id]); renderChat(); renderRoster(); renderProfile(); document.getElementById(`ag-${hit.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }) }
})

// ---------------------------------------------------------------- company: tickets + event log

let selected = null
let seenEventId = null
let ticketUnsub = null
const kindLabel = { chat: "💬 Chat", ticket: "📋 New ticket", spec: "📝 Spec", question: "❓ Question", answer: "💡 Answer", review_request: "🔍 Please review", changes: "✏️ Changes requested", approved: "✅ Approved", shipped: "🚀 Shipped", failed: "💥 Failed" }

subscribe("Company", CID, s => {
  $("#boot").textContent = `brain boot #${s.bootCount ?? "?"}`
  if (s.roster) syncRoster(s.roster)
  renderTickets(s.tickets ?? [])
  renderLog(s.events ?? [])
  const evs = s.events ?? []
  if (seenEventId === null) { seenEventId = evs.length ? evs[evs.length - 1].id : 0; return }
  for (const e of evs) {
    if (e.id <= seenEventId) continue
    seenEventId = e.id
    if (e.kind === "relay" && people[e.from]) {
      const k = e.text.split(":")[0]
      const body = e.text.slice(k.length + 1).trim()
      people[e.from].bubble = { text: body, head: `${kindLabel[k] ?? k} → @${e.to}`, at: performance.now(), ttl: 7000 }
    } else if (e.kind === "relay" && e.from === "customer" && people[e.to]) {
      people[e.to].bubble = { text: e.text.replace(/^ticket:\s*/, ""), head: "📋 Ticket from @customer", at: performance.now(), ttl: 6000 }
    } else if (e.kind === "relay" && e.from === "boss" && people[e.to]) {
      people[e.to].bubble = { text: e.text.replace(/^chat:\s*(\[[^\]]*\]\s*)?/, ""), head: "💬 From @boss (you)", at: performance.now(), ttl: 6000 }
    } else if (e.kind === "staff" && people[e.from]) {
      people[e.from].bubble = { text: e.text, head: "👋 Staffing", at: performance.now(), ttl: 8000 }
    } else if (e.kind === "tool" && people[e.from]) {
      people[e.from].toolBubble = { text: e.text, at: performance.now(), ttl: 2500 }
    }
    if (e.ticketId && (!selected || e.kind === "system" && e.text.startsWith("Filed"))) select(e.ticketId)
  }
})

function renderTickets(tickets) {
  const el = $("#tickets")
  if (!tickets.length) { el.innerHTML = `<div class="empty">No tickets yet.</div>`; return }
  el.innerHTML = ""
  for (const t of [...tickets].reverse()) {
    const d = document.createElement("div")
    d.className = "tk" + (t.id === selected ? " sel" : "")
    d.innerHTML = `<span><b>${t.id}</b> ${esc(t.title)}</span><span class="pill s-${t.state}">${t.state}</span>`
    d.onclick = () => select(t.id)
    el.appendChild(d)
  }
  if (!selected) select(tickets[tickets.length - 1].id)
}

function renderLog(events) {
  const el = $("#log")
  const atBottom = el.scrollTop < 30
  el.innerHTML = events.slice(-150).reverse().map(e => {
    const who = e.to ? `@${e.from} → @${e.to}` : `@${e.from}`
    return `<div class="ev ${e.kind}"><div class="meta">${new Date(e.ts).toLocaleTimeString()} · ${e.kind === "relay" ? "via Agent Relay" : e.kind} · ${who}${e.ticketId ? " · " + e.ticketId : ""}</div>${esc(e.text.slice(0, 400))}</div>`
  }).join("") || `<div class="empty">No events yet.</div>`
  if (atBottom) el.scrollTop = 0
}

// ---------------------------------------------------------------- ticket detail

const STAGES = ["queued", "speccing", "implementing", "reviewing", "fixing", "verifying", "done"]
let diffMode = "diff", currentTicket = null, detailsOpen = false

function select(id) {
  if (selected === id) return
  selected = id
  ticketUnsub?.()
  ticketUnsub = subscribe("Ticket", `ticket-${id}`, s => { currentTicket = s; renderDetail(s) })
}

function renderDetail(t) {
  const idx = STAGES.indexOf(t.state)
  const steps = STAGES.map((s, i) => {
    let c = "step"
    if (t.state === "failed") c += " bad"
    else if (t.state === "done" || i < idx) c += " ok"
    else if (i === idx) c += " on"
    return `<div class="${c}" title="${s}"></div>`
  }).join("")
  const left = t.deadline ? Math.max(0, Math.round((t.deadline - Date.now()) / 1000)) : 0
  $("#detail").innerHTML = `
    <h2>${esc(t.ticketId)} · <span class="pill s-${t.state}">${t.state}</span></h2>
    <div style="font-size:17px;font-weight:600">${esc(t.title)}</div>
    <div class="steps">${steps}</div>
    <div class="kv">
      <span>Tests</span><b>${t.testsPassed === null ? "not run" : t.testsPassed ? "✅ passing" : "❌ failing"}</b>
      <span>Time</span><b>${t.finishedAt ? `${Math.round((t.finishedAt - t.createdAt) / 1000)}s` : `${left}s left`}</b>
      <span>LLM calls</span><b>${t.llmCalls} / ${t.limits.maxLlmCalls}${cfg.mock ? " (mock)" : ""}</b>
    </div>
    ${t.state === "failed" ? `<div class="fail"><b>${/token ceiling/i.test(t.failureReason) ? "Paused" : "Failed"} while ${esc(t.failedStage || "?")}</b>: ${esc(t.failureReason)}
      <div class="row" style="margin-top:8px;align-items:center">
        ${(t.retries ?? 0) < (t.maxRetries ?? 3) ? `${/token ceiling/i.test(t.failureReason) ? `<button class="small" onclick="resetTokens().then(() => retryTicket('${t.ticketId}','resume', this))">Reset tokens &amp; resume</button>` : `<button class="small" onclick="retryTicket('${t.ticketId}','resume', this)">Retry from ${esc(t.failedStage || "start")}</button>`}
        <button class="secondary small" onclick="retryTicket('${t.ticketId}','scratch', this)">Retry from scratch</button>` : `<span>No retries left.</span>`}
        <span class="muted">retries ${t.retries ?? 0}/${t.maxRetries ?? 3}</span>
        ${/token ceiling/i.test(t.failureReason) ? `<a href="#" onclick="resetTokens();return false">Reset tokens</a>` : ""}
      </div></div>` : t.retries ? `<div class="muted">retries ${t.retries}/${t.maxRetries ?? 3}</div>` : ""}
    ${t.state === "done" ? tryBlock(t) : ""}
    <details id="moreDetails" ${detailsOpen ? "open" : ""}>
      <summary>Details</summary>
      <div class="kv">
        <span>Team</span><b>${["pm", "engineer", "reviewer"].map(r => t.assignees?.[r] ? `${ROLE_STYLE[r].label}: ${esc(nameOf(t.assignees[r]))}` : "").filter(Boolean).join(" · ") || "–"}</b>
        <span>Branch</span><b>${esc(t.branch || "–")}</b>
        <span>Review</span><b>${t.reviews.length} / ${t.limits.maxReviewRounds} rounds</b>
        <span>Commits</span><b>${t.commits.join(", ") || "–"}</b>
        ${t.resumes ? `<span>Resumed</span><b>${t.resumes}× after restart</b>` : ""}
      </div>
      ${t.spec ? `<div class="spec"><pre>${esc(t.spec)}${t.plan.length ? "\n\nPlan:\n" + t.plan.map((p, i) => `${i + 1}. ${esc(p)}`).join("\n") : ""}</pre></div>` : ""}
      <div class="reviews">${t.reviews.map(r => `<div>${r.verdict === "approve" ? "✅" : "✏️"} <b>Round ${r.round}</b>: ${esc(r.comments.slice(0, 300))}</div>`).join("")}</div>
    </details>`
  $("#moreDetails").addEventListener("toggle", e => { detailsOpen = e.target.open })
  renderDiff()
}

function renderDiff() {
  const t = currentTicket, el = $("#diff")
  if (!t) return
  if (diffMode === "tests") { el.innerHTML = `<pre>${esc(t.testOutput || "No test run yet.")}</pre>`; return }
  if (!t.diff) { el.innerHTML = `<div class="empty">The diff appears once the engineer commits.</div>`; return }
  el.innerHTML = `<pre>${t.diff.split("\n").map(l => {
    const c = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") ? "f" : l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : ""
    return `<span class="${c}">${esc(l)}</span>`
  }).join("\n")}</pre>`
}
$("#diffTab").onclick = () => { diffMode = "diff"; renderDiff() }
$("#testTab").onclick = () => { diffMode = "tests"; renderDiff() }
setInterval(() => currentTicket && !currentTicket.finishedAt && renderDetail(currentTicket), 1000)

// ---------------------------------------------------------------- filing tickets

async function file(body) {
  $("#fileBtn").disabled = $("#demoBtn").disabled = true
  try {
    const r = await fetch("/api/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json())
    if (r.id) { selected = null; select(r.id) }
    else alert(r.error ?? "failed")
  } finally { $("#fileBtn").disabled = $("#demoBtn").disabled = false }
}
$("#form").onsubmit = e => { e.preventDefault(); const title = $("#title").value.trim(); if (title) { file({ title, description: $("#desc").value }); $("#title").value = ""; $("#desc").value = "" } }
$("#demoBtn").onclick = () => file({ demo: true })

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]) }

// ---------------------------------------------------------------- roster: hire + replace

function nameOf(id) { return roster.find(r => r.id === id)?.name ?? id }

function renderRoster() {
  const el = $("#roster")
  if (!el) return
  const active = roster.filter(r => r.status === "active"), retired = roster.filter(r => r.status === "retired")
  $("#rosterCount").textContent = `${active.length} / 8 active`
  el.innerHTML = active.map(r => {
    const p = people[r.id] ?? {}
    return `<div class="agent${r.id === focusAgent ? " sel" : ""}" id="ag-${r.id}">
      <div class="row" style="justify-content:space-between;align-items:center">
        <span><b>${esc(r.name)}</b> <span class="pill role-${r.role}">${r.role}</span> <span class="muted">${esc(p.status ?? "")}</span></span>
        <span><button class="secondary small" data-replace="${r.id}">Replace…</button> <button class="secondary small" data-remove="${r.id}" data-name="${esc(r.name)}">Remove</button></span>
      </div>
      ${r.persona ? `<div class="muted">“${esc(r.persona)}”</div>` : ""}
      <div class="muted">${(p.notes ?? []).length} memory notes${r.replaces ? ` · took over from ${esc(nameOf(r.replaces))}` : ""}${p.task ? ` · ${esc(p.task)}` : ""}</div>
      <form class="replaceForm" data-for="${r.id}" style="display:${r.id === focusAgent && replaceOpen ? "flex" : "none"}">
        <input name="name" placeholder="Replacement's name" maxlength="24" required />
        <input name="persona" placeholder="Persona (optional)" maxlength="200" />
        <button type="submit">Replace ${esc(r.name)}</button>
      </form>
    </div>`
  }).join("") + (retired.length ? `<details id="alumni" ${alumniOpen ? "open" : ""} style="margin-top:6px"><summary class="muted" style="cursor:pointer">Alumni (${retired.length})</summary>` + retired.map(r =>
    `<div class="agent retired"><b>${esc(r.name)}</b> <span class="pill role-${r.role}">${r.role}</span> <span class="muted">retired ${new Date(r.retiredAt).toLocaleTimeString()}${r.replacedBy ? `, replaced by ${esc(nameOf(r.replacedBy))}` : ", removed"}</span></div>`).join("") + `</details>` : "")
  el.querySelector("#alumni")?.addEventListener("toggle", e => { alumniOpen = e.target.open })
  el.querySelectorAll("[data-remove]").forEach(b => b.onclick = async () => {
    if (!confirm(`Remove ${b.dataset.name} from the office? Their unfinished work moves to another ${b.closest(".agent").querySelector(".pill").textContent}.`)) return
    const r = await post(`/api/agents/${b.dataset.remove}/remove`, {})
    if (r.error) alert(r.error)
  })
  el.querySelectorAll("[data-replace]").forEach(b => b.onclick = () => { focusAgent = b.dataset.replace; replaceOpen = true; renderRoster(); el.querySelector(`form[data-for="${focusAgent}"] input`)?.focus() })
  el.querySelectorAll(".replaceForm").forEach(f => f.onsubmit = async e => {
    e.preventDefault()
    const fd = new FormData(f)
    const r = await post(`/api/agents/${f.dataset.for}/replace`, { name: fd.get("name"), persona: fd.get("persona") })
    if (r.error) alert(r.error); else { replaceOpen = false; focusAgent = r.hired }
  })
}
let replaceOpen = false, alumniOpen = false
setInterval(() => { if (!document.activeElement?.closest?.("#roster")) renderRoster() }, 2000)

// ---------------------------------------------------------------- agent profile (opens when an agent is selected)

const promptCache = {}
let promptOpen = false, memoryOpen = true
async function loadPrompt(id, persona) {
  const key = `${id}|${persona}`
  if (promptCache[key]) return promptCache[key]
  const r = await fetch(`/api/agents/${id}/prompt`).then(r => r.json()).catch(() => ({}))
  return (promptCache[key] = r.prompt ?? "(not available)")
}
async function renderProfile() {
  const card = $("#profileCard"), r = roster.find(x => x.id === focusAgent)
  if (!r || r.status !== "active") { card.style.display = "none"; return }
  const p = people[r.id] ?? {}
  card.style.display = ""
  const prompt = await loadPrompt(r.id, r.persona)
  const notes = p.notes ?? [], chat = p.chat ?? [], s = p.stats ?? {}
  $("#profile").innerHTML = `
    <div style="font-size:17px;font-weight:600">${esc(r.name)} <span class="pill role-${r.role}">${r.role}</span></div>
    ${r.persona ? `<div class="muted">“${esc(r.persona)}”</div>` : ""}
    <div class="kv" style="margin-top:8px">
      <span>Status</span><b>${esc(p.status ?? "idle")}</b>
      <span>Doing now</span><b>${esc(p.task || "nothing")}</b>
      <span>Hired</span><b>${r.hiredAt ? new Date(r.hiredAt).toLocaleTimeString() : "at start"}${r.replaces ? ` · took over from ${esc(nameOf(r.replaces))}` : ""}</b>
      <span>Activity</span><b>${s.ticketsTouched ?? 0} tickets · ${s.llmCalls ?? 0} LLM calls · ${s.messagesSent ?? 0} messages</b>
      <span>Chat turns</span><b>${chat.length}</b>
      <span>Relay address</span><b>@${esc(r.id)}</b>
    </div>
    <details id="memDetails" ${memoryOpen ? "open" : ""}>
      <summary>Memory (${notes.length} notes)</summary>
      ${notes.length ? `<ul class="memlist">${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : `<div class="empty">No memories yet.</div>`}
    </details>
    <details id="promptDetails" ${promptOpen ? "open" : ""}>
      <summary>System prompt</summary>
      <pre class="promptbox">${esc(prompt)}</pre>
    </details>`
  $("#memDetails").addEventListener("toggle", e => { memoryOpen = e.target.open })
  $("#promptDetails").addEventListener("toggle", e => { promptOpen = e.target.open })
}
$("#profileClose").onclick = () => { focusAgent = null; renderRoster(); renderProfile() }
setInterval(renderProfile, 2000)

async function post(url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ error: String(e) }))
}
$("#hireForm").onsubmit = async e => {
  e.preventDefault()
  const fd = new FormData($("#hireForm"))
  const r = await post("/api/agents", { name: fd.get("name"), role: fd.get("role"), persona: fd.get("persona") })
  if (r.error) alert(r.error); else { $("#hireForm").reset(); focusAgent = r.id }
}

// ---------------------------------------------------------------- "try the shipped app" links (generated per ticket by the engineer)

const tryResults = {} // `${ticket}${path}` -> { ok: true|false|null, text }
function tryBlock(t) {
  const links = t.tryLinks ?? []
  const rows = links.map(l => {
    const r = tryResults[t.ticketId + l.path]
    const badge = !r ? "" : r.ok === true ? `<span class="pill s-done">pass</span>` : r.ok === false ? `<span class="pill s-failed">fail</span>` : ""
    return `<div style="margin-top:4px">${badge} <a href="/preview/${t.ticketId}${esc(l.path)}" target="_blank"><code>${esc(l.path)}</code></a> ${esc(l.label)}
      ${l.expect ? `<div class="muted">expect: ${esc(l.expect)}</div>` : ""}${r ? `<div class="muted">${esc(r.text)}</div>` : ""}</div>`
  }).join("")
  return `<div class="spec"><b>Try the shipped app</b> (runs this ticket's code live; links suggested by the engineer)
    ${links.length ? `<button class="secondary small" onclick="runAllTries('${t.ticketId}')">Run all</button>` : ""}
    ${rows || `<div class="muted">No suggested links for this ticket.</div>`}
    <div style="margin-top:6px"><a href="#" onclick="const p=prompt('Path to open, e.g. /pumpkins/2'); if(p) window.open('/preview/${t.ticketId}'+p); return false">custom path…</a></div></div>`
}

/** pass/fail only when the expectation is checkable: "N items" and/or `exact text` in backticks. */
function checkExpect(expect, body) {
  let compact = body
  let json
  try { json = JSON.parse(body); compact = JSON.stringify(json) } catch {}
  const checks = []
  const n = expect.match(/(\d+)\s+items?/i)
  if (n) checks.push(Array.isArray(json) && json.length === Number(n[1]))
  for (const m of expect.matchAll(/`([^`]+)`/g)) checks.push(compact.includes(m[1]) || body.includes(m[1]))
  return checks.length ? checks.every(Boolean) : null
}

window.runAllTries = async id => {
  const t = currentTicket
  if (!t || t.ticketId !== id) return
  for (const l of t.tryLinks ?? []) {
    try {
      const res = await fetch(`/preview/${id}${l.path}`)
      const body = await res.text()
      tryResults[id + l.path] = { ok: res.ok ? checkExpect(l.expect, body) : false, text: `${res.status} · ${body.slice(0, 100)}` }
    } catch (e) { tryResults[id + l.path] = { ok: false, text: String(e) } }
    renderDetail(t)
  }
}

// ---------------------------------------------------------------- chat with agents (human = @boss on Agent Relay)

let chatTargets = new Set()
const ROLE_COLOR = r => ROLE_STYLE[r]?.color ?? "#ccc"
function renderChat() {
  const chips = $("#chatChips"), thread = $("#chatThread")
  if (!chips) return
  const active = roster.filter(r => r.status === "active")
  for (const id of [...chatTargets]) if (!active.some(r => r.id === id)) chatTargets.delete(id)
  chips.innerHTML = `<button type="button" class="chip${chatTargets.size === active.length && active.length ? " on" : ""}" data-chip="*">everyone</button>` +
    active.map(r => `<button type="button" class="chip${chatTargets.has(r.id) ? " on" : ""}" data-chip="${r.id}" style="--c:${ROLE_COLOR(r.role)}">${esc(r.name)}</button>`).join("")
  chips.querySelectorAll("[data-chip]").forEach(b => b.onclick = () => {
    const id = b.dataset.chip
    if (id === "*") chatTargets = chatTargets.size === active.length ? new Set() : new Set(active.map(r => r.id))
    else chatTargets.has(id) ? chatTargets.delete(id) : chatTargets.add(id)
    renderChat()
  })
  const ids = [...chatTargets]
  $("#chatSummary").textContent = ids.length ? `Chat · ${ids.map(nameOf).join(", ")}` : "Chat with the team"
  if (!ids.length) { thread.innerHTML = `<div class="empty">Pick someone to chat with (or click a character).</div>`; return }
  // One agent: its whole thread. Several: turns that involved all of them, merged; the boss's message shown once.
  const seen = new Set(), turns = []
  for (const id of ids) for (const t of people[id]?.chat ?? []) {
    if (ids.length > 1 && !ids.every(x => t.group.includes(x))) continue
    const key = t.from === "boss" ? `boss|${t.text}|${Math.round(t.ts / 5000)}` : `${t.from}|${t.ts}`
    if (seen.has(key)) continue
    seen.add(key); turns.push(t)
  }
  turns.sort((a, b) => a.ts - b.ts)
  thread.innerHTML = turns.slice(-40).map(t => {
    if (t.from === "boss") return `<div class="msg me">${esc(t.text)}</div>`
    const r = roster.find(x => x.id === t.from)
    return `<div class="msg"><b style="color:${ROLE_COLOR(r?.role)}">${esc(r?.name ?? t.from)}</b> ${esc(t.text)}</div>`
  }).join("") || `<div class="empty">No messages yet.</div>`
  thread.scrollTop = thread.scrollHeight
}
$("#chatForm").onsubmit = async e => {
  e.preventDefault()
  const text = $("#chatText").value.trim()
  if (!text || !chatTargets.size) return
  $("#chatSend").disabled = true
  const r = await post("/api/chat", { to: [...chatTargets], text })
  $("#chatSend").disabled = false
  if (r.error) alert(r.error); else $("#chatText").value = ""
}
setInterval(renderChat, 3000)

window.retryTicket = async (id, mode, btn) => {
  if (mode === "scratch" && !confirm(`Retry ${id} from scratch? The partial work is discarded and a fresh branch is started.`)) return
  btn.closest(".row").querySelectorAll("button").forEach(b => b.disabled = true) // a second click is ignored
  const r = await post(`/api/tickets/${id}/retry`, { mode })
  if (r.error) { alert(r.error); btn.closest(".row").querySelectorAll("button").forEach(b => b.disabled = false) }
}


// ---------------------------------------------------------------- token counter (header chip + reset)

async function refreshTokens() {
  const t = await fetch("/api/tokens").then(r => r.json()).catch(() => null)
  if (!t) return
  const el = $("#tokens")
  el.textContent = `tokens ${Math.round(t.used / 1000)}k / ${Math.round(t.cap / 1000)}k · reset`
  el.style.color = t.used >= t.cap * 0.9 ? "#ff9aa9" : ""
}
window.resetTokens = async () => {
  await fetch("/api/tokens", { method: "POST" })
  await refreshTokens()
}
$("#tokens").onclick = window.resetTokens
refreshTokens()
setInterval(refreshTokens, 4000)
