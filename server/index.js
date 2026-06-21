// Relay backend: pulls lightning strikes from Blitzortung (or the simulator),
// and fans them out to every connected browser over a single /live WebSocket.
// A browser can't reach the Blitzortung feed directly (origin/decode/ToS), so
// this process is the bridge — and it lets many tabs share one upstream socket.

import './env.js'   // MUST be first — loads .env before modules read process.env
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { startSim } from './sim.js'
import { startBlitzortung } from './blitzortung.js'
import { startQuakes, getQuakes, startRadar, getRadar, startAurora, getAurora } from './feeds.js'
import { ingest as ingestCell, startCells } from './cells.js'
import { startAircraft, getPlanes, pokeAircraft } from './aircraft.js'
import { startFires, getFires, pokeFires } from './fires.js'
import { startNarrator } from './narrator.js'
import { ask } from './ask.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8088)
// live | sim | auto  (auto = live feed, fall back to sim if it stays silent)
const MODE = process.env.BLITZ_MODE || 'auto'

const app = express()
app.use(express.json())

// In production serve the built frontend from dist/.
if (process.env.NODE_ENV === 'production') {
  const dist = path.join(__dirname, '..', 'dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.get('/health', (_req, res) => res.json({ ok: true, mode: activeMode, total }))
app.get('/radar', (_req, res) => res.json(getRadar() || { host: '', past: [], nowcast: [] }))
app.get('/aurora', (_req, res) => res.json({ aurora: getAurora() }))
app.post('/ask', async (req, res) => {
  // Accept a conversation (preferred) or a single question for back-compat.
  let history = Array.isArray(req.body?.messages) ? req.body.messages : null
  if (!history && req.body?.question) history = [{ role: 'user', content: req.body.question }]
  if (!history || !history.length) return res.json({ text: 'Ask me something about the live lightning.', toolTrace: [], actions: [] })
  res.json(await ask(history, { recent, cells: latestCells, quakes: getQuakes() }))
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/live' })

// Rolling buffer of recent strikes so a freshly-loaded page — or a pan to a new
// area — isn't empty. Capped by time AND count so a storm firehose can't bloat
// it. The upstream Blitzortung feed is a single GLOBAL stream (no per-area
// subscription exists), so we keep the whole world here and filter per client.
const RECENT_MS = 5 * 60 * 1000
const RECENT_MAX = 2000
const recent = []
let total = 0
let lastPerMin = 0
let activeMode = MODE === 'auto' ? 'connecting' : MODE

// Is a strike inside a client's viewport bbox [west, south, east, north]?
// A null bbox = "everything" (no viewport reported yet). A span ≥ 360° (zoomed
// out past one world) also means everything; west > east wraps the antimeridian.
function inBbox(bbox, lat, lon) {
  if (!bbox) return true
  const [w, s, e, n] = bbox
  if (lat < s || lat > n) return false
  if (e - w >= 360) return true
  if (w <= e) return lon >= w && lon <= e
  return lon >= w || lon <= e
}

let strikeId = 0

// Compress detector-station geometry into a confidence-ellipse {a, e} (major-axis
// angle in the local east/north frame, eccentricity) so the client can draw the
// GDOP halo WITHOUT us shipping all the stations. Computed once per strike here,
// not per frame on the client.
function computeGd(sig, lat, lon) {
  const toR = Math.PI / 180, cosLat = Math.cos(lat * toR)
  let mxx = 0, mxy = 0, myy = 0, k = 0
  for (const st of sig) {
    let dx = (st.lo - lon) * cosLat, dy = st.la - lat
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) continue
    dx /= len; dy /= len
    mxx += dx * dx; mxy += dx * dy; myy += dy * dy; k++
  }
  if (k < 2) return null
  const tr = mxx + myy
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (mxx * myy - mxy * mxy)))
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc
  if (l1 <= 1e-9) return null
  const e = Math.sqrt(Math.max(0, 1 - l2 / l1))
  const a = Math.abs(mxy) > 1e-9 ? Math.atan2(l2 - mxx, mxy) : (mxx <= myy ? 0 : Math.PI / 2)
  return { a: +a.toFixed(3), e: +e.toFixed(3) }
}

// Lean wire shape — everything EXCEPT the heavy sig[] (up to 60 stations), which
// stays server-side in `recent` and is fetched on demand via {t:'reveal', id}.
function leanOf(s) {
  return { id: s.id, lat: s.lat, lon: s.lon, time: s.time, pol: s.pol, region: s.region, e: s.e, mcg: s.mcg, gd: s.gd, mode: s.mode }
}

function pushRecent(strike) {
  recent.push(strike)
  const cutoff = Date.now() - RECENT_MS
  while (recent.length && (recent[0].time < cutoff || recent.length > RECENT_MAX)) {
    recent.shift()
  }
}

function broadcast(strike) {
  total++
  strike.id = ++strikeId
  if (strike.sig && strike.sig.length >= 2 && !strike.gd) strike.gd = computeGd(strike.sig, strike.lat, strike.lon)
  pushRecent(strike)          // full strike (with sig) retained for the reveal
  ingestCell(strike)
  const payload = JSON.stringify({ t: 'strike', s: leanOf(strike) })
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && inBbox(client._bbox, strike.lat, strike.lon)) {
      client.send(payload)
    }
  }
}

wss.on('connection', (ws) => {
  ws._bbox = null   // until the client reports its viewport, send it everything
  ws._pid = Math.random().toString(36).slice(2, 8)   // anonymous presence id
  ws.send(JSON.stringify({ t: 'hello', mode: activeMode, serverTime: Date.now() }))
  const q = getQuakes()
  if (q.length) ws.send(JSON.stringify({ t: 'quakes', quakes: q }))

  // The client reports its map viewport here; we store it and reply with the
  // recent history inside that box so a pan/zoom fills in immediately.
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.t === 'view' && Array.isArray(msg.bbox) && msg.bbox.length === 4) {
      ws._bbox = msg.bbox.map(Number)
      const snap = recent.filter((s) => inBbox(ws._bbox, s.lat, s.lon)).map(leanOf)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'snapshot', recent: snap, serverTime: Date.now() }))
        const cs = latestCells.filter((c) => inBbox(ws._bbox, c.lat, c.lon))
        ws.send(JSON.stringify({ t: 'cells', cells: cs }))
      }
    } else if (msg.t === 'reveal' && typeof msg.id === 'number') {
      const s = recent.find((r) => r.id === msg.id)   // full sig kept server-side
      if (s && s.sig && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'reveal', id: s.id, lat: s.lat, lon: s.lon, mcg: s.mcg, sig: s.sig }))
      }
    } else if (msg.t === 'flights') {
      ws._flights = !!msg.on   // gate OpenSky polling to clients actually watching
      if (ws._flights) pokeAircraft()
    } else if (msg.t === 'desk') {
      ws._desk = !!msg.on      // gate the AI narrator to clients actually watching
    } else if (msg.t === 'fires') {
      ws._fires = !!msg.on
      if (ws._fires) pokeFires()
    } else if (msg.t === 'presence' && typeof msg.lon === 'number' && typeof msg.lat === 'number') {
      ws._center = { lon: msg.lon, lat: msg.lat }   // map-view centre, not a real location
    }
  })
})

// Storm Ghosts: broadcast where other viewers have centred their map (anonymous).
setInterval(() => {
  const all = [...wss.clients].filter((c) => c._center && c.readyState === WebSocket.OPEN)
    .map((c) => ({ pid: c._pid, lon: c._center.lon, lat: c._center.lat }))
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    client.send(JSON.stringify({ t: 'presence', viewers: all.filter((p) => p.pid !== client._pid) }))
  }
}, 3000)

// Periodically push live stats (rate, source) to all clients for the HUD.
setInterval(() => {
  const cutoff = Date.now() - 60000
  const lastMin = recent.filter((s) => s.time >= cutoff).length
  lastPerMin = lastMin
  const payload = JSON.stringify({ t: 'stats', mode: activeMode, total, perMin: lastMin })
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload)
  }
}, 1000)

// ---- Source wiring -------------------------------------------------------
let stopSim = null

function startSimSource() {
  if (stopSim) return
  activeMode = MODE === 'auto' ? 'sim (fallback)' : 'sim'
  console.log(`[relay] simulation source active`)
  stopSim = startSim(broadcast)
}

if (MODE === 'sim') {
  startSimSource()
} else {
  // live or auto: connect to Blitzortung.
  let gotLive = false
  startBlitzortung((strike) => {
    if (!gotLive) {
      gotLive = true
      activeMode = 'live'
      if (stopSim) { stopSim(); stopSim = null; console.log('[relay] live feed up — stopping fallback sim') }
      console.log('[relay] live Blitzortung feed active')
    }
    broadcast(strike)
  })

  if (MODE === 'auto') {
    // If the live feed produces nothing within 12s, light up the simulator so
    // the map is never dead. The sim is stopped automatically once live strikes
    // start arriving (see above).
    setTimeout(() => { if (!gotLive) startSimSource() }, 12000)
  }
}

// External open-data feeds: earthquakes (broadcast on update) + radar index.
startQuakes((quakes) => {
  const payload = JSON.stringify({ t: 'quakes', quakes })
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload)
  }
})
startRadar()
startAurora()

// Storm-cell tracker: broadcast per-client (filtered to each viewport).
let latestCells = []
startCells((list) => {
  latestCells = list
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    const cs = client._bbox ? list.filter((c) => inBbox(client._bbox, c.lat, c.lon)) : list
    client.send(JSON.stringify({ t: 'cells', cells: cs }))
  }
})

// Boxes to poll for a per-client layer: the client's viewport when zoomed in
// (clamped cheap), else the busiest storm cells. Shared by flights + fires.
function clientBoxes(flag, pad, fallbackPad) {
  const boxes = []
  for (const c of wss.clients) {
    if (!c[flag] || !c._bbox) continue
    const [w, s, e, n] = c._bbox
    if (Math.max(e - w, n - s) <= 60) {
      const cx = (w + e) / 2, cy = (s + n) / 2
      boxes.push({ w: Math.max(w, cx - pad), e: Math.min(e, cx + pad), s: Math.max(s, cy - pad), n: Math.min(n, cy + pad) })
    }
    if (boxes.length >= 2) break
  }
  if (!boxes.length) {
    for (const cell of [...latestCells].sort((a, b) => b.rate - a.rate).slice(0, 2)) {
      boxes.push({ s: cell.lat - fallbackPad, n: cell.lat + fallbackPad, w: cell.lon - fallbackPad, e: cell.lon + fallbackPad })
    }
  }
  return boxes.slice(0, 2)
}
startAircraft(() => ([...wss.clients].some((c) => c._flights) ? clientBoxes('_flights', 12, 2.2) : []), () => latestCells)

// Fires follow the viewport centre (not storm cells) so they appear wherever you
// look — fire-prone regions (Africa, Australia, Siberia, US west) are dense; pan
// there to see lots. (Polled within 1 box around each fire-client's view centre.)
function fireBoxes() {
  const boxes = []
  for (const c of wss.clients) {
    if (!c._fires || !c._bbox) continue
    const [w, s, e, n] = c._bbox
    const cx = (w + e) / 2, cy = (s + n) / 2
    const pad = 13
    boxes.push({ w: cx - pad, e: cx + pad, s: Math.max(-85, cy - pad), n: Math.min(85, cy + pad) })
    if (boxes.length >= 2) break
  }
  return boxes.slice(0, 2)
}
startFires(fireBoxes, () => latestCells)

// AI "Storm Desk" narrator (Claude Haiku via OpenRouter) — only runs while a
// client is listening, and only the detection layer decides when to speak.
startNarrator(
  () => ({ cells: latestCells, perMin: lastPerMin }),
  () => [...wss.clients].some((c) => c._desk),
  (n) => {
    const payload = JSON.stringify({ t: 'narration', ...n })
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client._desk) client.send(payload)
    }
  }
)
setInterval(() => {
  const planes = JSON.stringify({ t: 'planes', planes: getPlanes() })
  const fires = JSON.stringify({ t: 'fires', fires: getFires() })
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    if (client._flights) client.send(planes)
    if (client._fires) client.send(fires)
  }
}, 4000)

server.listen(PORT, () => {
  console.log(`[relay] lightning relay on http://localhost:${PORT}  (mode: ${MODE})`)
})
