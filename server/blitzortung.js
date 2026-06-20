// Live connection to the Blitzortung.org lightning network.
//
// Blitzortung has no official REST API; its public web map streams strikes over
// a WebSocket. Messages are NOT plain JSON — they are compressed with a small
// LZW-style scheme and must be decoded before JSON.parse. This module connects,
// subscribes, decodes, normalises each strike, and hands it to a callback. It
// rotates between mirror servers and reconnects with backoff on failure.
//
// The exact endpoint list, subscribe payload and decode function are pinned to
// what known working clients use; see README "Live feed" for sources.

import { WebSocket } from 'ws'

// Mirror servers the public map connects to. They are interchangeable; we round
// robin on failure so a single dead mirror doesn't take us down. (ws1/ws2/ws7/
// ws8 are the hosts referenced by the current official map bundle.)
const ENDPOINTS = [
  'wss://ws1.blitzortung.org/',
  'wss://ws2.blitzortung.org/',
  'wss://ws7.blitzortung.org/',
  'wss://ws8.blitzortung.org/',
]

// Magic handshake value sent on connect to start the strike stream. Blitzortung
// rotates this integer server-side (older clients sent 418; 111 is the current
// value, confirmed across several live clients). If the stream ever goes silent,
// re-scrape the current value from the map.blitzortung.org JS bundle.
const SUBSCRIBE = JSON.stringify({ a: 111 })

// LZW-variant decompression used by the Blitzortung web client. A raw incoming
// frame is a string of code points; this expands it back into the original JSON
// text — then JSON.parse gives one strike object.
//
// NB: a compressed frame often *starts* with a literal `{"time":` prefix (those
// bytes are < 256 and pass straight through) yet still contains dictionary codes
// further in — so never early-return on a leading '{'. Decoding is idempotent
// for pure-ASCII input, so it's always safe to run. Array.from + codePointAt
// keep any high code points the dictionary produces intact.
export function decodeBlitz(input) {
  if (!input) return ''
  const chars = Array.from(String(input))
  if (chars.length === 0) return ''
  const dict = {}
  let currChar = chars[0]
  let oldPhrase = currChar
  const out = [currChar]
  let code = 256
  for (let i = 1; i < chars.length; i++) {
    const cc = chars[i].codePointAt(0)
    let phrase
    if (cc < 256) phrase = chars[i]                       // literal char
    else if (dict[cc] !== undefined) phrase = dict[cc]    // known dictionary entry
    else phrase = oldPhrase + currChar                    // LZW KwKwK special case
    out.push(phrase)
    currChar = phrase.charAt(0)
    dict[code] = oldPhrase + currChar
    code++
    oldPhrase = phrase
  }
  return out.join('')
}

function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000, toR = Math.PI / 180
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR
  const la1 = aLat * toR, la2 = bLat * toR
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

// Normalise a decoded strike object to our wire shape. The feed uses time in
// nanoseconds since the Unix epoch; we convert to milliseconds. We also keep the
// detector stations that heard the strike (trimmed) and derive a RELATIVE
// intensity proxy `e` from detection geometry — more & farther stations and
// tighter coverage ⇒ a stronger stroke. NB: `e` is relative, NOT calibrated kA.
function normalise(obj) {
  if (obj == null || typeof obj.lat !== 'number' || typeof obj.lon !== 'number') return null
  const timeMs = typeof obj.time === 'number' ? Math.round(obj.time / 1e6) : Date.now()

  let sig = null
  let e = 0.4
  const mcg = typeof obj.mcg === 'number' ? obj.mcg : null
  if (Array.isArray(obj.sig) && obj.sig.length) {
    const stations = obj.sig
      .filter((s) => typeof s.lat === 'number' && typeof s.lon === 'number')
      .slice(0, 60)
      .map((s) => ({ la: s.lat, lo: s.lon, t: s.time }))   // trimmed: lat, lon, TOA-delay
    let maxDist = 0
    for (const s of stations) {
      const d = haversineM(obj.lat, obj.lon, s.la, s.lo)
      if (d > maxDist) maxDist = d
    }
    const n = obj.sig.length
    const coverage = mcg != null ? Math.max(0, 1 - mcg / 360) : 0.5
    e = Math.max(0.15, Math.min(1,
      0.12 + 0.45 * Math.min(1, n / 40) + 0.3 * Math.min(1, maxDist / 2.2e6) + 0.13 * coverage))
    if (stations.length) sig = stations
  }

  return {
    lat: obj.lat,
    lon: obj.lon,
    time: timeMs,
    pol: obj.pol ?? 0,
    region: obj.region ?? 0,
    e,
    mcg,
    sig,
    mode: 'live',
  }
}

export function startBlitzortung(onStrike, { log = console.log } = {}) {
  let ws = null
  let endpointIdx = 0
  let backoff = 1000
  let closed = false
  let heartbeat = null

  function connect() {
    if (closed) return
    const url = ENDPOINTS[endpointIdx % ENDPOINTS.length]
    log(`[blitz] connecting → ${url}`)
    // A bare connection is accepted — no Origin / auth / custom headers needed.
    // (If a mirror ever presents an untrusted cert, add { rejectUnauthorized: false }.)
    ws = new WebSocket(url)

    ws.on('open', () => {
      log(`[blitz] connected to ${url}`)
      backoff = 1000
      ws.send(SUBSCRIBE)
      // Keep the connection warm with a protocol-level ping.
      heartbeat = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.ping()
      }, 30000)
    })

    ws.on('message', (raw) => {
      let text
      try {
        text = decodeBlitz(typeof raw === 'string' ? raw : raw.toString('utf8'))
        const obj = JSON.parse(text)
        const strike = normalise(obj)
        if (strike) onStrike(strike)
      } catch {
        // Non-strike control frames and decode hiccups are ignored.
      }
    })

    const reconnect = (why) => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
      if (closed) return
      endpointIdx++
      const wait = Math.min(backoff, 30000)
      log(`[blitz] ${why}; reconnecting in ${wait}ms`)
      backoff = Math.min(backoff * 2, 30000)
      setTimeout(connect, wait)
    }

    ws.on('close', () => reconnect('closed'))
    ws.on('error', (err) => reconnect(`error: ${err.message}`))
  }

  connect()

  return () => {
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    if (ws) ws.close()
  }
}
