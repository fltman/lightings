// The Storm Desk — an AI situational narrator.
//
// HONEST BY CONSTRUCTION: the server decides IF there is news using plain stats
// (global-rate z-score + per-cell rate/state from the tracker). Only then does a
// compact digest of VERIFIED numbers go to a cheap LLM (Claude Haiku via
// OpenRouter) to phrase ONE sentence. The model never detects, never invents a
// place (we reverse-geocode the cell first), never predicts, never says kA or a
// storm type. Most of the time we don't call it at all — silence is the feature.

const COOLDOWN_RISING = 60 * 1000
const COOLDOWN_ACTIVE = 4 * 60 * 1000
const COOLDOWN_QUIET = 12 * 60 * 1000

const SYS = `You are a terse wire-service weather desk for a live global lightning map.
Given a JSON object of VERIFIED numbers, write ONE sentence (max 22 words) reporting the current lightning situation.
RULES:
- Use ONLY the numbers and the place string provided. Never invent a place name, a number, kA/energy, or a storm type (no "supercell", "severe", "tornadic").
- Present or past tense only. NEVER predict the future.
- Be vivid but factual, like a calm news ticker.
- If nothing in the data is genuinely noteworthy, output exactly: SILENT`

async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`)
    const j = await r.json()
    const parts = [j.locality || j.city, j.principalSubdivision, j.countryName].filter(Boolean)
    if (parts.length) return parts.slice(0, 2).join(', ')
    return j.localityInfo?.informative?.[0]?.name || `${lat.toFixed(0)}°, ${lon.toFixed(0)}°`
  } catch {
    return `${lat.toFixed(0)}°, ${lon.toFixed(0)}°`
  }
}

async function phrase(digest, log) {
  const KEY = process.env.OPENROUTER_API_KEY
  const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5'
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 60,
        temperature: 0.5,
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: JSON.stringify(digest) },
        ],
      }),
    })
    const j = await r.json()
    if (j.error) { log(`[narrator] ${j.error.message}`); return null }
    const text = (j.choices?.[0]?.message?.content || '').trim()
    return text
  } catch (e) {
    log(`[narrator] ${e.message}`)
    return null
  }
}

// getState() -> { cells, perMin }.  wants() -> bool (someone is listening).
export function startNarrator(getState, wants, onNarration, { log = console.log } = {}) {
  if (!process.env.OPENROUTER_API_KEY) { log('[narrator] no OPENROUTER_API_KEY — Storm Desk disabled'); return () => {} }
  let baseline = null
  let lastSpoke = 0
  let lastText = ''
  let busy = false

  async function tick() {
    if (busy || !wants()) return
    const { cells, perMin } = getState()
    baseline = baseline == null ? perMin : baseline * 0.9 + perMin * 0.1
    const now = Date.now()

    const top = cells.slice().sort((a, b) => b.rate - a.rate)[0]
    const surge = baseline > 5 && perMin > baseline * 1.6
    const regime = surge ? 'outbreak' : (top && top.rate >= 10) ? 'active' : 'quiet'
    const cooldown = top && top.state === 'rising' && top.rate >= 12 ? COOLDOWN_RISING
      : regime === 'quiet' ? COOLDOWN_QUIET : COOLDOWN_ACTIVE
    if (now - lastSpoke < cooldown) return

    // Only bother the model when there's a real anchor.
    if (regime === 'quiet' && (!top || top.rate < 4)) {
      if (now - lastSpoke < COOLDOWN_QUIET) return
    }

    busy = true
    try {
      const place = top ? await reverseGeocode(top.lat, top.lon) : 'worldwide'
      const digest = {
        regime,
        global_strikes_per_min: Math.round(perMin),
        baseline_per_min: Math.round(baseline),
        active_cells: cells.length,
        top_cell: top ? { place, strikes_per_min: top.rate, trend: top.state, span_km: top.spreadKm } : null,
      }
      const text = await phrase(digest, log)
      if (text && text !== 'SILENT' && text.toUpperCase() !== 'SILENT' && text !== lastText) {
        lastSpoke = now
        lastText = text
        onNarration({ text, regime, cell: top ? { id: top.id, lat: top.lat, lon: top.lon } : null, time: now })
        log(`[narrator] ${text}`)
      }
    } finally {
      busy = false
    }
  }

  const t = setInterval(tick, 30000)
  setTimeout(tick, 8000)   // an early first read
  return () => clearInterval(t)
}
