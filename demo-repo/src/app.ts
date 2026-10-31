// A tiny Bun HTTP app with a hackathon landing page and the existing pumpkin API.

export type Pumpkin = { id: number; name: string; weightKg: number; spooky: boolean }

export const pumpkins: Pumpkin[] = [
  { id: 1, name: "Jack", weightKg: 4.2, spooky: true },
  { id: 2, name: "Gourdon", weightKg: 7.9, spooky: false },
  { id: 3, name: "Lady Squash", weightKg: 3.1, spooky: true },
]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function aboutPage(): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#18251e">
  <title>About — Pumpkin Patch API</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7f2;
      color: #1d2c23;
      font-synthesis: none;
      text-rendering: optimizeLegibility;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; min-height: 100vh; }
    .page { min-height: 100vh; display: grid; place-items: center; padding: 2rem 1.25rem; }
    main { width: min(100%, 680px); padding: clamp(2rem, 7vw, 4.5rem); background: #fff; border: 1px solid #e2e9df; border-radius: 1.25rem; box-shadow: 0 24px 70px rgba(29, 44, 35, .07); }
    .eyebrow { margin: 0 0 1rem; color: #507b5d; font-size: .75rem; font-weight: 750; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(2.5rem, 8vw, 4.5rem); line-height: 1.02; letter-spacing: -.065em; }
    .description { max-width: 510px; margin: 1.5rem 0 0; color: #526158; font-size: 1.1rem; line-height: 1.75; }
    .endpoint { display: inline-flex; align-items: center; gap: .65rem; margin-top: 2rem; padding: .7rem .9rem; border-radius: .55rem; background: #eef4ed; color: #30573a; font-size: .9rem; }
    .method { font-size: .72rem; font-weight: 800; letter-spacing: .08em; }
    .accordion { margin-top: 2rem; border-top: 1px solid #e2e9df; }
    .accordion-item { border-bottom: 1px solid #e2e9df; }
    .accordion-trigger { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1rem .25rem; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; font-size: 1rem; font-weight: 700; cursor: pointer; }
    .accordion-trigger:hover { color: #30573a; }
    .accordion-trigger:focus-visible { outline: 3px solid #6da878; outline-offset: 3px; border-radius: .25rem; }
    .indicator { flex: 0 0 auto; color: #507b5d; font-size: 1.25rem; transition: transform .18s ease; }
    .accordion-trigger[aria-expanded="true"] .indicator { transform: rotate(45deg); }
    .accordion-panel { padding: 0 .25rem 1rem; color: #526158; line-height: 1.7; }
    .accordion-panel[hidden] { display: none; }
    .accordion-panel p { margin: 0; }
    @media (max-width: 520px) {
      .page { display: block; padding: 1rem; }
      main { padding: 1.75rem 1.25rem; border-radius: 1rem; }
      .description { font-size: 1rem; }
    }
    @media (prefers-reduced-motion: reduce) { .indicator { transition: none; } }
  </style>
</head>
<body>
  <div class="page">
    <main aria-labelledby="page-title">
      <p class="eyebrow">A small API for curious developers</p>
      <h1 id="page-title">Pumpkin Patch API</h1>
      <p class="description">The Pumpkin Patch API provides a simple way to explore a collection of pumpkins, with details such as each pumpkin’s name, weight, and spooky status.</p>
      <p class="endpoint"><span class="method">GET</span><code>/pumpkins</code> <span>— list pumpkins</span></p>
      <section class="accordion" aria-label="About the API">
        <div class="accordion-item">
          <h2><button class="accordion-trigger" id="about-trigger-collection" type="button" aria-expanded="true" aria-controls="about-panel-collection">The pumpkin collection <span class="indicator" aria-hidden="true">＋</span></button></h2>
          <div class="accordion-panel" id="about-panel-collection" role="region" aria-labelledby="about-trigger-collection"><p>Explore a collection of pumpkins.</p></div>
        </div>
        <div class="accordion-item">
          <h2><button class="accordion-trigger" id="about-trigger-details" type="button" aria-expanded="false" aria-controls="about-panel-details">Pumpkin details <span class="indicator" aria-hidden="true">＋</span></button></h2>
          <div class="accordion-panel" id="about-panel-details" role="region" aria-labelledby="about-trigger-details" hidden><p>Each pumpkin has details such as its name, weight, and spooky status.</p></div>
        </div>
        <div class="accordion-item">
          <h2><button class="accordion-trigger" id="about-trigger-endpoint" type="button" aria-expanded="false" aria-controls="about-panel-endpoint">List pumpkins <span class="indicator" aria-hidden="true">＋</span></button></h2>
          <div class="accordion-panel" id="about-panel-endpoint" role="region" aria-labelledby="about-trigger-endpoint" hidden><p>Use <code>GET /pumpkins</code> to list pumpkins.</p></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    document.querySelectorAll('.accordion-trigger').forEach((trigger) => {
      trigger.addEventListener('click', () => {
        const expanded = trigger.getAttribute('aria-expanded') === 'true';
        const panel = document.getElementById(trigger.getAttribute('aria-controls'));
        trigger.setAttribute('aria-expanded', String(!expanded));
        panel.hidden = expanded;
      });
    });
  </script>
</body>
</html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

function landingPage(): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#17131c">
  <title>Hackathon — Coming soon</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #17131c;
      color: #f8f1e7;
      font-synthesis: none;
      text-rendering: optimizeLegibility;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; min-height: 100vh; }
    a { color: inherit; }
    a:focus-visible { outline: 3px solid #ffd39d; outline-offset: 5px; }
    .page {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      padding: clamp(1.25rem, 4vw, 3rem) clamp(1.25rem, 7vw, 7rem);
      overflow: hidden;
      position: relative;
      isolation: isolate;
    }
    .page::before {
      content: "";
      position: absolute;
      z-index: -1;
      width: min(70vw, 760px);
      aspect-ratio: 1;
      border-radius: 50%;
      right: -15%;
      top: 8%;
      background: radial-gradient(circle, rgba(242, 133, 57, .2), rgba(242, 133, 57, 0) 68%);
      pointer-events: none;
    }
    header, footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .wordmark { font-size: .9rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .edition { color: #c8becd; font-size: .85rem; }
    main { display: flex; align-items: center; padding: 5rem 0; }
    .hero { max-width: 880px; }
    .eyebrow { color: #ffb36b; font-size: .8rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 1rem 0 1.25rem; max-width: 800px; font-size: clamp(3.5rem, 11vw, 8.5rem); line-height: .94; letter-spacing: -.075em; }
    .description { max-width: 540px; color: #d0c7d1; font-size: clamp(1.05rem, 2vw, 1.25rem); line-height: 1.7; }
    .cta { display: inline-flex; align-items: center; gap: .75rem; margin-top: 1.5rem; padding: 1rem 1.25rem; border-radius: .6rem; background: #f28b45; color: #21140d; font-size: .95rem; font-weight: 750; text-decoration: none; transition: background-color .18s ease, transform .18s ease; }
    .cta:hover { background: #ffad6b; transform: translateY(-2px); }
    .cta span { font-size: 1.15rem; }
    .status { display: block; margin-top: 1rem; color: #bdb2c2; font-size: .85rem; }
    footer { color: #bdb2c2; font-size: .8rem; }
    .motif { position: absolute; right: clamp(1.5rem, 8vw, 8rem); top: 50%; width: clamp(4rem, 8vw, 7rem); aspect-ratio: 1; color: #ffb36b; opacity: .82; transform: translateY(-50%); pointer-events: none; }
    .motif svg { display: block; width: 100%; height: 100%; }
    @media (max-width: 700px) { .motif { right: 1.5rem; top: 27%; width: 3.5rem; opacity: .55; } }
    @media (max-width: 520px) {
      .page { padding: 1.25rem; }
      main { padding: 4rem 0; }
      header, footer { align-items: flex-start; }
      .edition { text-align: right; }
      footer { flex-direction: column; }
      .motif { top: 23%; right: 1.35rem; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <span class="wordmark">Hackathon</span>
      <span class="edition">Ideas start here</span>
    </header>
    <div class="motif" aria-hidden="true">
      <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M50 20c-5-8-3-14 4-17 2 7 1 12-4 17Z" fill="currentColor"/>
        <path d="M47 25c-17-8-34 3-34 24 0 24 17 39 37 39s37-15 37-39c0-21-17-32-34-24-2 1-4 1-6 0Z" fill="currentColor"/>
        <path d="M50 27c-8 17-8 42 0 59M33 28c-8 17-8 39 2 53M67 28c8 17 8 39-2 53" stroke="#17131c" stroke-width="3" stroke-linecap="round" opacity=".38"/>
        <path d="m34 48 10 8-10 7V48Zm32 0-10 8 10 7V48Zm-20 24 4-5 4 5h-8Z" fill="#17131c" opacity=".8"/>
      </svg>
    </div>
    <main>
      <section class="hero" aria-labelledby="hero-title">
        <p class="eyebrow">Make something remarkable</p>
        <h1 id="hero-title">Hackathon</h1>
        <p class="description">A gathering for curious minds to build, experiment, and bring bold ideas to life. More details are on the way.</p>
        <a class="cta" href="mailto:hello@example.com?subject=Hackathon%20updates">Get event updates <span aria-hidden="true">↗</span></a>
        <span class="status" role="status">Event details coming soon</span>
      </section>
    </main>
    <footer><span>Big ideas. Hands-on making.</span><span>Stay curious.</span></footer>
  </div>
</body>
</html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

export function handle(req: Request): Response {
  const url = new URL(req.url)

  if (req.method === "GET" && url.pathname === "/") {
    return landingPage()
  }

  if (req.method === "GET" && url.pathname === "/hackathon") {
    return landingPage()
  }

  if (req.method === "GET" && url.pathname === "/about") {
    return aboutPage()
  }

  if (req.method === "GET" && url.pathname === "/pumpkins") {
    return json(pumpkins)
  }

  if (req.method === "GET" && url.pathname === "/pumpkins/lightest") {
    const lightest = pumpkins.reduce<Pumpkin | undefined>(
      (current, pumpkin) => !current || pumpkin.weightKg < current.weightKg ? pumpkin : current,
      undefined,
    )
    return lightest ? json(lightest) : json({ error: "not found" }, 404)
  }

  const match = url.pathname.match(/^\/pumpkins\/(\d+)$/)
  if (req.method === "GET" && match) {
    const pumpkin = pumpkins.find(p => p.id === Number(match[1]))
    return pumpkin ? json(pumpkin) : json({ error: "not found" }, 404)
  }

  return json({ error: "not found" }, 404)
}
