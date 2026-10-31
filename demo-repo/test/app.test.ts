import { describe, expect, test } from "bun:test"
import { handle, pumpkins } from "../src/app"

const get = (path: string) => handle(new Request(`http://localhost${path}`))

describe("hackathon landing page", () => {
  test("GET / serves the page successfully with its key content and call to action", async () => {
    const res = get("/")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")

    const body = await res.text()
    expect(body).toContain("<title>Hackathon — Coming soon</title>")
    expect(body).toContain('<h1 id="hero-title">Hackathon</h1>')
    expect(body).toContain("A gathering for curious minds to build, experiment, and bring bold ideas to life.")
    expect(body).toContain('class="cta"')
    expect(body).toContain("Get event updates")
    expect(body).toContain('@media (max-width: 520px)')
    expect(body).toContain('background: #17131c')
    expect(body).toContain('background: #f28b45')
    expect(body).toContain('color: #f8f1e7')
    expect(body).toContain('a:focus-visible')
    expect(body).toContain('class="motif" aria-hidden="true"')
    expect(body).toContain('prefers-reduced-motion: reduce')
  })

  test("GET /hackathon serves the placeholder page as HTML", async () => {
    const res = get("/hackathon")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")

    const body = await res.text()
    expect(body).toContain('<h1 id="hero-title">Hackathon</h1>')
    expect(body).toContain("Get event updates")
  })
})

describe("about page", () => {
  test("GET /about serves its existing API information with accessible accordion sections", async () => {
    const res = get("/about")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")

    const body = await res.text()
    expect(body).toContain("<title>About — Pumpkin Patch API</title>")
    expect(body).toContain('<h1 id="page-title">Pumpkin Patch API</h1>')
    expect(body).toContain("provides a simple way to explore a collection of pumpkins")
    expect(body).toContain("each pumpkin’s name, weight, and spooky status")
    expect(body).toContain("GET</span><code>/pumpkins</code>")

    for (const section of ["collection", "details", "endpoint"]) {
      expect(body).toContain(`id="about-trigger-${section}"`)
      expect(body).toContain(`aria-controls="about-panel-${section}"`)
      expect(body).toContain(`id="about-panel-${section}"`)
      expect(body).toContain(`aria-labelledby="about-trigger-${section}"`)
    }
    expect(body).toContain('aria-expanded="true"')
    expect(body).toContain('aria-expanded="false"')
    expect(body).toContain("panel.hidden = expanded")
    expect(body).toContain("trigger.setAttribute('aria-expanded', String(!expanded))")
    expect(body).toContain(".accordion-trigger:focus-visible")
    expect(body).toContain("@media (max-width: 520px)")
  })
})

describe("pumpkin patch api", () => {
  test("GET /pumpkins lists pumpkins", async () => {
    const res = get("/pumpkins")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(3)
  })

  test("GET /pumpkins/:id returns one pumpkin", async () => {
    const res = get("/pumpkins/2")
    expect(await res.json()).toMatchObject({ name: "Gourdon" })
  })

  test("GET /pumpkins/lightest returns the lowest-weight pumpkin", async () => {
    const res = get("/pumpkins/lightest")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual(pumpkins[2])
  })

  test("GET /pumpkins/lightest uses collection order when weights tie", async () => {
    const originalWeights = pumpkins.map(pumpkin => pumpkin.weightKg)
    try {
      pumpkins[0].weightKg = 1
      pumpkins[1].weightKg = 1
      expect(await get("/pumpkins/lightest").json()).toEqual(pumpkins[0])
    } finally {
      pumpkins.forEach((pumpkin, index) => { pumpkin.weightKg = originalWeights[index] })
    }
  })

  test("GET /pumpkins/lightest returns not found for an empty collection", async () => {
    const original = pumpkins.splice(0)
    try {
      const res = get("/pumpkins/lightest")
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: "not found" })
    } finally {
      pumpkins.push(...original)
    }
  })

  test("unknown routes 404", () => {
    expect(get("/nope").status).toBe(404)
  })
})
