// Ask the Planet — a tool-use agent over the live data.
//
// The user asks a question; Claude (via OpenRouter) answers AND can drive the map
// — but every NUMBER and LOCATION comes from a deterministic JS tool over the
// real buffer, so the model can't fabricate counts, places, or storm motion. The
// reply ships with a "receipt" (the exact tool calls) and any map actions.
//
// HONEST SCOPE: the strike buffer is only the last ~5 minutes, global. No kA, no
// storm-type labels, no prediction beyond storm_approach.

const SYS = `You are "Ask the Planet", the assistant for a live global lightning map.
Answer the user's question in 1-3 short sentences, using the TOOLS to get every real number and location — never guess counts, places, or energy.
The strike buffer holds only the LAST ~5 MINUTES, globally; if asked about longer history, say you can only see the last few minutes.
Rules: never invent a place name (use geocode); never say kA or a storm type (no "supercell"/"severe"); only describe storm motion from storm_approach, never otherwise predict.
When the question is about a place, geocode it, fly_to it, then query_strikes there. Use drop_pin for "is it heading toward me / my area" style questions.
Reply conversationally and concisely. Light markdown is welcome (bold for key numbers, short bullet lists) but keep it tight — usually 1-3 sentences.`

const TOOLS = [
  { type: 'function', function: { name: 'geocode', description: 'Resolve a place name to lat/lon.', parameters: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] } } },
  { type: 'function', function: { name: 'query_strikes', description: 'Lightning stats over the last few minutes for an area. Give either center+radiusKm, or a bbox, or nothing for the whole globe.', parameters: { type: 'object', properties: { centerLat: { type: 'number' }, centerLon: { type: 'number' }, radiusKm: { type: 'number' }, west: { type: 'number' }, south: { type: 'number' }, east: { type: 'number' }, north: { type: 'number' }, sinceMin: { type: 'number', description: 'lookback minutes, max 5' } } } } },
  { type: 'function', function: { name: 'top_cells', description: 'The most active tracked storm cells right now.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } } },
  { type: 'function', function: { name: 'storm_approach', description: 'Is any tracked storm cell heading toward this point, and the ETA.', parameters: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } }, required: ['lat', 'lon'] } } },
  { type: 'function', function: { name: 'fly_to', description: 'Move the map camera to a location.', parameters: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, zoom: { type: 'number' } }, required: ['lat', 'lon'] } } },
  { type: 'function', function: { name: 'drop_pin', description: "Drop the user's location pin at a point (enables the safety guardian there).", parameters: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } }, required: ['lat', 'lon'] } } },
]

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = Math.PI / 180
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

async function geocode(place) {
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en`)
    const j = await r.json()
    const g = j.results?.[0]
    return g ? { lat: g.latitude, lon: g.longitude, name: [g.name, g.country].filter(Boolean).join(', ') } : { error: 'place not found' }
  } catch { return { error: 'geocode failed' } }
}

function approach(cells, lat, lon) {
  const toR = Math.PI / 180, cosLat = Math.cos(lat * toR)
  let best = null
  for (const c of cells) {
    if (c.rate < 6) continue
    const ex = (lon - c.lon) * 111 * cosLat, ny = (lat - c.lat) * 111
    const vx = c.vlon * 111 * cosLat, vy = c.vlat * 111
    const vv = vx * vx + vy * vy
    if (vv < 1e-10) continue
    const tca = -(ex * vx + ny * vy) / vv
    if (tca <= 0 || tca > 3600) continue
    const minDist = Math.hypot(ex + vx * tca, ny + vy * tca)
    if (minDist > (c.spreadKm || 40) + 40) continue
    const brg = (Math.atan2(-ex, -ny) / toR + 360) % 360
    if (!best || tca < best.tca) best = { tca, brg, id: c.id }
  }
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return best
    ? { approaching: true, minutes: Math.round(best.tca / 60), fromBearing: COMPASS[Math.round(best.brg / 45) % 8], cellId: best.id }
    : { approaching: false }
}

// history: the conversation so far as [{role:'user'|'assistant', content}].
export async function ask(history, ctx, { log = console.log } = {}) {
  const KEY = process.env.OPENROUTER_API_KEY
  const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.6'
  if (!KEY) return { text: 'AI is not configured (no OpenRouter key).', toolTrace: [], actions: [] }
  const { recent, cells } = ctx
  const actions = []
  const toolTrace = []

  function runTool(name, args) {
    if (name === 'fly_to') { actions.push({ type: 'fly_to', lat: args.lat, lon: args.lon, zoom: args.zoom || 6 }); return { ok: true } }
    if (name === 'drop_pin') { actions.push({ type: 'drop_pin', lat: args.lat, lon: args.lon }); return { ok: true } }
    if (name === 'top_cells') {
      return cells.slice().sort((a, b) => b.rate - a.rate).slice(0, args.limit || 5)
        .map((c) => ({ id: c.id, lat: +c.lat.toFixed(2), lon: +c.lon.toFixed(2), strikesPerMin: c.rate, trend: c.state, spanKm: c.spreadKm }))
    }
    if (name === 'storm_approach') return approach(cells, args.lat, args.lon)
    if (name === 'query_strikes') {
      const sinceMs = Math.min(5, args.sinceMin || 5) * 60000
      const cut = Date.now() - sinceMs
      let pts = recent.filter((s) => s.time >= cut)
      let areaDesc = 'the whole globe'
      if (typeof args.centerLat === 'number' && typeof args.radiusKm === 'number') {
        pts = pts.filter((s) => haversineKm(args.centerLat, args.centerLon, s.lat, s.lon) <= args.radiusKm)
        areaDesc = `within ${args.radiusKm} km`
      } else if (typeof args.west === 'number') {
        pts = pts.filter((s) => s.lat >= args.south && s.lat <= args.north && s.lon >= args.west && s.lon <= args.east)
        areaDesc = 'the given box'
      }
      const n = pts.length
      const pos = pts.filter((s) => s.pol > 0).length
      const meanE = n ? pts.reduce((a, s) => a + (s.e || 0), 0) / n : 0
      return { count: n, perMin: Math.round(n / (sinceMs / 60000)), positivePct: n ? Math.round((100 * pos) / n) : 0, meanRelEnergy: +meanE.toFixed(2), windowMin: sinceMs / 60000, area: areaDesc }
    }
    return { error: 'unknown tool' }
  }

  const turns = (history || []).slice(-12).map((m) => ({ role: m.role, content: String(m.content || '') }))
  const messages = [{ role: 'system', content: SYS }, ...turns]
  for (let i = 0; i < 6; i++) {
    let j
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, temperature: 0.3, tools: TOOLS, messages }),
      })
      j = await r.json()
    } catch (e) { return { text: `AI request failed: ${e.message}`, toolTrace, actions } }
    if (j.error) return { text: `AI error: ${j.error.message}`, toolTrace, actions }
    const m = j.choices?.[0]?.message
    if (!m) return { text: 'No response.', toolTrace, actions }
    messages.push(m)
    if (m.tool_calls && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
        let result
        if (tc.function.name === 'geocode') result = await geocode(args.place)
        else result = runTool(tc.function.name, args)
        toolTrace.push({ tool: tc.function.name, args, result })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      }
      continue
    }
    return { text: (m.content || '').trim() || '(no answer)', toolTrace, actions }
  }
  return { text: 'Sorry — I could not work that out.', toolTrace, actions }
}
