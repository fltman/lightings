import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import { StrikeFx } from './strikes.js'
import { HeatLayer } from './heatmap.js'
import { Thunder } from './thunder.js'
import { Reveal } from './reveal.js'
import { NightSide } from './nightside.js'
import { Guardian } from './guardian.js'
import { Globe } from './globe.js'
import { drawQuake } from './quakes.js'
import { RadarLayer } from './radar.js'
import { AuroraLayer } from './aurora.js'
import { drawCells } from './cellview.js'
import { drawPlanes } from './aircraftview.js'
import { drawFire } from './firesview.js'
import { EarthBreathe } from './earthbreathe.js'
import { marked } from 'marked'
marked.setOptions({ breaks: true })

// ---- Map ------------------------------------------------------------------
// Dark CARTO basemap (raster, no API key required).
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      carto: {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        ],
        tileSize: 256,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a> · Lightning data provided by <a href="https://www.blitzortung.org">Blitzortung.org</a> (<a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>)',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#05060a' } },
      { id: 'carto', type: 'raster', source: 'carto', paint: { 'raster-opacity': 0.9 } },
    ],
  },
  center: [12, 40],
  zoom: 2.1,
  minZoom: 1,
  maxZoom: 12,
  dragRotate: false,
  preserveDrawingBuffer: true,   // lets "Clip" composite the WebGL canvas
  attributionControl: { compact: true },
})
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')

// ---- Heatmap layer (hot areas, decaying over time) ------------------------
const heat = new HeatLayer(map)
setInterval(() => heat.tick(), 1500)

// ---- Earthquakes + radar (open data) --------------------------------------
const quakeMap = new Map()        // id -> quake (with ._seen perf-time)
let quakes = []
let showQuakes = true
let cells = []                    // tracked storm cells
let showCells = false
let showFlares = false            // flare-up sentinel
const flares = []                 // active flare-up pins {id, lat, lon, rate, born}
const flaredIds = new Set()       // cells currently flared (avoid re-pinning)
let viewers = []                  // other people watching (anonymous map centres)

// Storm Ghosts: faint markers where other viewers have centred their map.
function drawGhosts(ctx, now, w, h) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 600)
  for (const v of viewers) {
    const p = map.project([v.lon, v.lat])
    if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath(); ctx.arc(p.x, p.y, 6 + pulse * 4, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(185,165,255,${0.25 + pulse * 0.2})`; ctx.lineWidth = 1.5; ctx.stroke()
    ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(205,185,255,0.7)'; ctx.fill()
    ctx.restore()
  }
}

// Detect sudden intensifications from the cell stream: a cell that has just gone
// "rising" with a high rate gets a pulsing alert pin for ~75 s.
function updateFlares(list) {
  const now = performance.now()
  const present = new Set()
  for (const c of list) {
    present.add(c.id)
    const isFlare = c.state === 'rising' && c.rate >= 20
    if (isFlare && !flaredIds.has(c.id)) {
      flaredIds.add(c.id)
      flares.push({ id: c.id, lat: c.lat, lon: c.lon, rate: c.rate, born: now })
    } else if (!isFlare) {
      flaredIds.delete(c.id)        // can flare again if it re-intensifies later
    }
  }
  for (const id of [...flaredIds]) if (!present.has(id)) flaredIds.delete(id)
  for (let i = flares.length - 1; i >= 0; i--) if (now - flares[i].born > 75000) flares.splice(i, 1)
}

function drawFlares(ctx, now) {
  for (const fl of flares) {
    const p = map.project([fl.lon, fl.lat])
    const age = (now - fl.born) / 1000
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let k = 0; k < 2; k++) {
      const ph = (age * 1.1 + k * 0.5) % 1
      ctx.beginPath()
      ctx.arc(p.x, p.y, 8 + ph * 30, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,140,60,${(1 - ph) * 0.6})`
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,185,95,0.95)'; ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif'
    const label = `⚡ FLARE-UP · ${fl.rate}/min`
    const tw = ctx.measureText(label).width
    ctx.fillStyle = 'rgba(40,12,8,0.8)'; ctx.fillRect(p.x + 10, p.y - 20, tw + 10, 17)
    ctx.fillStyle = 'rgba(255,185,100,1)'; ctx.fillText(label, p.x + 15, p.y - 8)
    ctx.restore()
  }
}
let planes = []                   // aircraft near active cells
let showFlights = false
let fires = []                    // active fire detections (FIRMS)
let showFires = false

const radar = new RadarLayer(map)
const aurora = new AuroraLayer(map)
let showAurora = false
const breathe = new EarthBreathe()
let breatheActive = false
map.on('load', () => {
  radar.load().then((ok) => { if (ok) wireRadarScrubber() })
  aurora.load()
  setInterval(() => aurora.load(), 5 * 60000)  // refresh the auroral oval
})

// ---- Effect engines -------------------------------------------------------
const fx = new StrikeFx()
const thunder = new Thunder()
const reveal = new Reveal()
const nightside = new NightSide()
const guardian = new Guardian(document.getElementById('guardian'))

// Thunder fires when a ring reaches the "ear" (the located pin, else map centre).
fx.onThunder = (distM, pol, e) => thunder.fire(distM, pol, e)
setInterval(() => { guardian.cells = cells; guardian.update(fx.strikes) }, 200)

const canvas = document.getElementById('fx')
const ctx = canvas.getContext('2d')
const globe = new Globe(document.getElementById('globe'))
globe.fx = fx
let dpr = Math.min(window.devicePixelRatio || 1, 2)

function sizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = window.innerWidth
  const h = window.innerHeight
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = w + 'px'
  canvas.style.height = h + 'px'
  globe.resize(w, h, dpr)
}
sizeCanvas()
window.addEventListener('resize', sizeCanvas)
map.on('resize', sizeCanvas)

function frame() {
  const now = performance.now()
  const w = canvas.width / dpr
  const h = canvas.height / dpr

  if (globe.active) {
    // Globe mode: the ear is the located pin, else the point facing the camera.
    fx.ear = guardian.pin || globe.centerPoint()
    globe.night = nightside.enabled
    globe.quakes = showQuakes ? quakes : []
    globe.fires = showFires ? fires : []
    globe.aurora = showAurora ? aurora.points : []
    globe.render(now, new Date())
    fx.cull(now)                                // keep the buffer bounded (render does this in flat mode)
  } else {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const c = map.getCenter()
    fx.ear = guardian.pin || { lat: c.lat, lon: c.lng }
    nightside.render(ctx, map, w, h, new Date())  // dark wash (source-over), under strikes
    fx.render(ctx, map, now, w, h)                // additive strikes
    reveal.render(ctx, map)                       // multilateration overlay
    guardian.render(ctx, map)                     // pin + thunder ETA
    if (showQuakes) {
      for (const q of quakes) {
        const p = map.project([q.lon, q.lat])
        if (p.x < -40 || p.x > w + 40 || p.y < -40 || p.y > h + 40) continue
        drawQuake(ctx, p.x, p.y, q, now - q._seen)
      }
    }
    if (showFires && fires.length) {
      for (const f of fires) {
        const p = map.project([f.lon, f.lat])
        if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue
        drawFire(ctx, p.x, p.y, f)
      }
    }
    if (showCells && cells.length) drawCells(ctx, cells, map, w, h)
    if (showFlights && planes.length) drawPlanes(ctx, planes, map, w, h)
    if (showFlares && flares.length) drawFlares(ctx, now)
    if (viewers.length) drawGhosts(ctx, now, w, h)
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// ---- Click: earthquake details, else strike reveal ------------------------
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const quakePopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '250px', className: 'quake-popup' })
function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return `${Math.round(s)} s ago`
  const m = s / 60; if (m < 90) return `${Math.round(m)} min ago`
  const h = m / 60; if (h < 36) return `${Math.round(h)} h ago`
  return `${Math.round(h / 24)} d ago`
}
function pickQuake(x, y) {
  let best = null, bestD = 16 * 16
  for (const q of quakes) {
    const p = map.project([q.lon, q.lat])
    const dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy
    if (d < bestD) { bestD = d; best = q }
  }
  return best
}
map.on('click', (ev) => {
  // Earthquakes first (sparse + informative); otherwise reveal a strike. The
  // station list is no longer streamed per strike (perf) — ask the relay by id.
  if (showQuakes) {
    const q = pickQuake(ev.point.x, ev.point.y)
    if (q) {
      const depth = typeof q.depth === 'number' ? `${q.depth.toFixed(0)} km deep` : 'depth n/a'
      const mag = typeof q.mag === 'number' ? q.mag.toFixed(1) : '?'
      quakePopup.setLngLat([q.lon, q.lat]).setHTML(
        `<div class="qp-mag">M ${mag}</div>` +
        `<div class="qp-place">${escapeHtml(q.place || 'Unknown location')}</div>` +
        `<div class="qp-meta">${depth} · ${timeAgo(q.time)}</div>` +
        `<a class="qp-link" href="https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(q.id)}" target="_blank" rel="noopener">USGS details ↗</a>`
      ).addTo(map)
      return
    }
  }
  const s = fx.pick(map, ev.point.x, ev.point.y, 22)
  if (s && s.sid != null && activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ t: 'reveal', id: s.sid }))
  }
})

// ---- HUD ------------------------------------------------------------------
const el = (id) => document.getElementById(id)
const statSource = el('stat-source')
const statRate = el('stat-rate')
const statTotal = el('stat-total')
const connToast = el('conn')

function setStats({ mode, perMin, total }) {
  if (mode != null) statSource.textContent = mode
  if (perMin != null) statRate.textContent = perMin.toLocaleString()
  if (total != null) statTotal.textContent = total.toLocaleString()
}

// ---- Toggles & controls ---------------------------------------------------
function wireToggle(id, initial, onChange) {
  const btn = el(id)
  let on = initial
  const apply = () => {
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-pressed', String(on))
  }
  apply()
  btn.addEventListener('click', () => { on = !on; apply(); onChange(on) })
}

// Globe ⇄ flat map. In globe mode you see the whole planet, so we ask the relay
// for the GLOBAL feed (no viewport filter); switching back restores the viewport.
const mapEl = document.getElementById('map')
wireToggle('globe-toggle', false, (on) => {
  globe.setActive(on)
  mapEl.style.display = on ? 'none' : ''
  canvas.style.display = on ? 'none' : ''
  if (!on) map.resize()
  sendView()
})

wireToggle('heat-toggle', true, (on) => heat.setVisible(on))
wireToggle('night-toggle', true, (on) => nightside.setEnabled(on))
wireToggle('sound-toggle', false, (on) => {
  if (on) {
    thunder.enable()
    fx.markAllFired()   // don't replay a barrage of past strikes when switching on
    fx.soundOn = true
  } else {
    fx.soundOn = false
    thunder.disable()
  }
})
wireToggle('breathe-toggle', false, (on) => {
  breatheActive = on
  if (on) breathe.enable(); else breathe.disable()
  sendView()            // global feed so you hear the whole planet
})
wireToggle('quakes-toggle', true, (on) => { showQuakes = on })
wireToggle('aurora-toggle', false, (on) => { showAurora = on; aurora.setVisible(on) })
wireToggle('cells-toggle', false, (on) => { showCells = on })
wireToggle('flares-toggle', false, (on) => { showFlares = on })
wireToggle('flights-toggle', false, (on) => {
  showFlights = on
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ t: 'flights', on }))
  }
  if (!on) planes = []
})
wireToggle('fires-toggle', false, (on) => {
  showFires = on
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ t: 'fires', on }))
  }
  if (!on) fires = []
})

// Storm Desk (AI narrator)
let showDesk = false
let deskTimer = null
const deskTicker = el('deskticker')
const deskText = el('desk-text')
let deskCell = null
function showNarration(msg) {
  if (!showDesk) return
  deskText.textContent = msg.text
  deskTicker.className = `panel deskticker${msg.regime === 'outbreak' ? ' outbreak' : ''}`
  deskTicker.hidden = false
  deskCell = msg.cell
  clearTimeout(deskTimer)
  deskTimer = setTimeout(() => { deskTicker.hidden = true }, 60000)
}
deskTicker.addEventListener('click', () => {
  if (deskCell) map.flyTo({ center: [deskCell.lon, deskCell.lat], zoom: Math.max(map.getZoom(), 5) })
})
wireToggle('desk-toggle', false, (on) => {
  showDesk = on
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ t: 'desk', on }))
  }
  if (!on) deskTicker.hidden = true
})

// Ask the Planet (AI chat agent)
const askPanel = el('ask')
const askInput = el('ask-input')
const askLog = el('ask-log')
const askHistory = []                 // [{role, content}]
const askIntro = askLog.innerHTML
el('ask-open').addEventListener('click', () => { askPanel.hidden = false; askInput.focus() })
el('ask-close').addEventListener('click', () => { askPanel.hidden = true })
function runAction(a) {
  if (a.type === 'fly_to') map.flyTo({ center: [a.lon, a.lat], zoom: a.zoom || 6 })
  else if (a.type === 'drop_pin') { guardian.setPin(a.lat, a.lon); sendView() }
}
function addBubble(role, html, thinking) {
  const wrap = document.createElement('div')
  wrap.className = `msg ${role}`
  const bubble = document.createElement('div')
  bubble.className = 'bubble' + (thinking ? ' thinking' : '')
  bubble.innerHTML = html
  wrap.appendChild(bubble)
  askLog.appendChild(wrap)
  askLog.scrollTop = askLog.scrollHeight
  return bubble
}
function addReceipt(bubble, trace) {
  if (!trace || !trace.length) return
  const d = document.createElement('details')
  d.className = 'ask-receipt'
  d.innerHTML = `<summary>receipt · ${trace.length} ${trace.length === 1 ? 'query' : 'queries'}</summary><div>` +
    trace.map((t) => `<div><code>${t.tool}</code>(${Object.entries(t.args || {}).map(([k, v]) => `${k}:${v}`).join(', ')})</div>`).join('') + '</div>'
  bubble.appendChild(d)
  askLog.scrollTop = askLog.scrollHeight
}
async function submitAsk() {
  const q = askInput.value.trim()
  if (!q) return
  askInput.value = ''
  addBubble('user', escapeHtml(q))
  askHistory.push({ role: 'user', content: q })
  const bubble = addBubble('assistant', 'thinking…', true)
  try {
    const r = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: askHistory }),
    })
    const j = await r.json()
    bubble.classList.remove('thinking')
    bubble.innerHTML = marked.parse(j.text || '(no answer)')
    for (const a of j.actions || []) runAction(a)
    addReceipt(bubble, j.toolTrace)
    askHistory.push({ role: 'assistant', content: j.text || '' })
  } catch (e) {
    bubble.classList.remove('thinking')
    bubble.textContent = 'Request failed: ' + e.message
  }
}
askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAsk() })
el('ask-send').addEventListener('click', submitAsk)
el('ask-clear').addEventListener('click', () => { askHistory.length = 0; askLog.innerHTML = askIntro })
wireToggle('radar-toggle', false, (on) => {
  radar.setVisible(on)
  const ctl = el('radar-ctl')
  if (ctl) ctl.hidden = !on || !radar.frames.length
})

function wireRadarScrubber() {
  const slider = el('radar-slider')
  const label = el('radar-time')
  if (!slider) return
  slider.max = String(Math.max(0, radar.frames.length - 1))
  slider.value = String(radar.idx)
  radar.onFrame = (frame, idx) => {
    slider.value = String(idx)
    const d = new Date(frame.time * 1000)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    label.textContent = `${frame.forecast ? 'FORECAST ' : ''}${hh}:${mm}`
  }
  slider.addEventListener('input', () => radar.setIndex(+slider.value))
}

// Locate me → guardian pin + "ear" for thunder + safety badge.
el('locate-btn').addEventListener('click', () => {
  const here = (lat, lon) => { guardian.setPin(lat, lon); map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 7) }); sendView() }
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => here(pos.coords.latitude, pos.coords.longitude),
      () => { const c = map.getCenter(); here(c.lat, c.lng) },   // denied → use map centre
      { enableHighAccuracy: false, timeout: 8000 }
    )
  } else {
    const c = map.getCenter(); here(c.lat, c.lng)
  }
})

// ---- Radio Mode: hands-off cinema that flies to the loudest storms --------
let radioActive = false
let radioTimer = null
let radioIdx = 0
let radioStartedAt = 0
const radioBtn = el('radio-toggle')
const radioHint = el('radio-hint')
function radioStep() {
  if (!radioActive) return
  const targets = cells.slice().sort((a, b) => b.rate - a.rate).slice(0, 6)
  if (targets.length) {
    const t = targets[radioIdx % targets.length]
    radioIdx++
    map.easeTo({ center: [t.lon, t.lat], zoom: 5.4, duration: 3500 })
    radioHint.textContent = `📻 RADIO · ⚡ ${t.rate} strikes/min · move mouse to exit`
  } else {
    radioHint.textContent = '📻 RADIO · waiting for active storms · move mouse to exit'
  }
  radioTimer = setTimeout(radioStep, 24000)
}
function startRadio() {
  radioActive = true
  radioStartedAt = performance.now()
  document.body.classList.add('radio')
  radioHint.hidden = false
  radioBtn.classList.add('active')
  sendView()            // subscribe globally so targets aren't limited to one view
  radioIdx = 0
  radioStep()
}
function stopRadio() {
  radioActive = false
  clearTimeout(radioTimer)
  document.body.classList.remove('radio')
  radioHint.hidden = true
  radioBtn.classList.remove('active')
  sendView()            // restore the real viewport subscription
}
radioBtn.addEventListener('click', () => (radioActive ? stopRadio() : startRadio()))
window.addEventListener('mousemove', () => {
  if (radioActive && performance.now() - radioStartedAt > 1500) stopRadio()
})

// ---- Clip It: record ~6 s of the live canvas to a downloadable WebM --------
let clipping = false
const clipBtn = el('clip-btn')
clipBtn.addEventListener('click', () => {
  if (clipping || !window.MediaRecorder) return
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) return
  clipping = true
  clipBtn.classList.add('active')
  const cv = document.createElement('canvas')
  cv.width = canvas.width
  cv.height = canvas.height
  const cctx = cv.getContext('2d')
  let raf = 0
  const composite = () => {
    cctx.clearRect(0, 0, cv.width, cv.height)
    if (globe.active) {
      cctx.drawImage(globe.canvas, 0, 0, cv.width, cv.height)
    } else {
      cctx.drawImage(map.getCanvas(), 0, 0, cv.width, cv.height)
      cctx.drawImage(canvas, 0, 0, cv.width, cv.height)
    }
    raf = requestAnimationFrame(composite)
  }
  composite()
  const chunks = []
  const rec = new MediaRecorder(cv.captureStream(30), { mimeType: mime })
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  rec.onstop = () => {
    cancelAnimationFrame(raf)
    const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'lightings-clip.webm'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 8000)
    clipping = false
    clipBtn.classList.remove('active')
  }
  rec.start()
  setTimeout(() => rec.stop(), 6000)
})

// ---- Live feed ------------------------------------------------------------
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/live`
}

// Viewport-driven subscription: tell the relay which area we're looking at so it
// only forwards strikes inside it. (The upstream Blitzortung feed is global —
// this filters per-browser; it does not, and cannot, "request" extra regions.)
let activeWs = null

function currentBbox() {
  const b = map.getBounds()
  let w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth()
  const dx = (e - w) * 0.25, dy = (n - s) * 0.25   // margin so a small pan has buffer
  w -= dx; e += dx; s -= dy; n += dy
  // Keep a small box around the located pin in view, so the guardian still hears
  // nearby strikes even when you've panned the map elsewhere.
  if (guardian.pin) {
    w = Math.min(w, guardian.pin.lon - 0.5); e = Math.max(e, guardian.pin.lon + 0.5)
    s = Math.min(s, guardian.pin.lat - 0.5); n = Math.max(n, guardian.pin.lat + 0.5)
  }
  return [w, Math.max(-85, s), e, Math.min(85, n)]
}

function sendView() {
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    // Globe / radio / Earth Breathe show or sonify the whole world → global feed.
    const bbox = (globe.active || radioActive || breatheActive) ? [-180, -85, 180, 85] : currentBbox()
    activeWs.send(JSON.stringify({ t: 'view', bbox }))
  }
}

function sendPresence() {
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    const c = map.getCenter()
    activeWs.send(JSON.stringify({ t: 'presence', lon: c.lng, lat: c.lat }))
  }
}
let viewTimer = null
map.on('moveend', () => { clearTimeout(viewTimer); viewTimer = setTimeout(() => { sendView(); sendPresence() }, 250) })

// Backdate seeded strikes by their real age so old ones show as faint embers and
// very recent ones still flash. Feed both the FX engine and the heatmap.
function seedRecent(list, serverNow, now) {
  for (const s of list || []) {
    const ageMs = Math.max(0, serverNow - s.time)
    fx.add(s, now - ageMs, { silent: true })   // seeded strikes never play thunder
    heat.add(s.lon, s.lat, s.time)
  }
}

let backoff = 800
function connect() {
  const ws = new WebSocket(wsUrl())
  activeWs = ws

  ws.onopen = () => {
    backoff = 800
    connToast.hidden = true
    sendView()   // report our viewport → relay replies with a filtered snapshot
    sendPresence()
    if (showFlights) ws.send(JSON.stringify({ t: 'flights', on: true }))
    if (showFires) ws.send(JSON.stringify({ t: 'fires', on: true }))
    if (showDesk) ws.send(JSON.stringify({ t: 'desk', on: true }))
  }

  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    const now = performance.now()
    const serverNow = msg.serverTime || Date.now()

    if (msg.t === 'hello') {
      setStats({ mode: msg.mode })
    } else if (msg.t === 'snapshot') {
      seedRecent(msg.recent, serverNow, now)
    } else if (msg.t === 'strike') {
      if (breatheActive) breathe.tick(msg.s.lat, msg.s.pol)
      fx.add(msg.s, now)
      heat.add(msg.s.lon, msg.s.lat, msg.s.time || Date.now())
    } else if (msg.t === 'stats') {
      setStats({ mode: msg.mode, perMin: msg.perMin, total: msg.total })
      if (breatheActive) breathe.setActivity(msg.perMin || 0)
    } else if (msg.t === 'quakes') {
      const next = []
      for (const q of msg.quakes || []) {
        const existing = quakeMap.get(q.id)
        q._seen = existing ? existing._seen : now   // bloom only newly-seen quakes
        quakeMap.set(q.id, q)
        next.push(q)
      }
      const ids = new Set(next.map((q) => q.id))
      for (const id of quakeMap.keys()) if (!ids.has(id)) quakeMap.delete(id)
      quakes = next
    } else if (msg.t === 'cells') {
      cells = msg.cells || []
      updateFlares(cells)
    } else if (msg.t === 'planes') {
      planes = msg.planes || []
    } else if (msg.t === 'fires') {
      fires = msg.fires || []
    } else if (msg.t === 'narration') {
      showNarration(msg)
    } else if (msg.t === 'reveal') {
      reveal.start({ lat: msg.lat, lon: msg.lon, mcg: msg.mcg, sig: msg.sig }, performance.now())
    } else if (msg.t === 'presence') {
      viewers = msg.viewers || []
      const wel = el('watchers')
      if (wel) { wel.hidden = viewers.length === 0; wel.textContent = `👁 ${viewers.length} also watching` }
    }
  }

  ws.onclose = () => {
    if (activeWs === ws) activeWs = null
    connToast.hidden = false
    backoff = Math.min(backoff * 1.6, 8000)
    setTimeout(connect, backoff)
  }
  ws.onerror = () => ws.close()
}
connect()
