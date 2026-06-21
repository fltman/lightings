// External open-data feeds, polled server-side and cached. All free, no key.
//   - USGS earthquakes (all_day GeoJSON, 1-min cadence)
//   - RainViewer precipitation-radar frame index (regenerates ~10 min)

let quakes = []
let radar = null
let aurora = []

export function getQuakes() { return quakes }
export function getRadar() { return radar }
export function getAurora() { return aurora }

// NOAA SWPC OVATION auroral oval — probability the aurora is visible on a global
// grid. We keep the meaningful high-latitude points so the client can draw the
// glowing oval over the night hemisphere. Free, no key, ~5-min cadence.
export function startAurora({ log = console.log } = {}) {
  async function poll() {
    try {
      const r = await fetch('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json')
      const j = await r.json()
      const out = []
      for (const c of j.coordinates || []) {
        const val = c[2]
        if (val < 8) continue                        // skip near-zero probability
        const lat = c[1]
        if (Math.abs(lat) < 40) continue             // aurora is polar
        const lon = c[0] > 180 ? c[0] - 360 : c[0]
        out.push({ lat, lon, val })
      }
      aurora = out
      log(`[aurora] ${out.length} active cells`)
    } catch (e) {
      log(`[aurora] ${e.message}`)
    }
  }
  poll()
  const t = setInterval(poll, 5 * 60000)
  return () => clearInterval(t)
}

export function startQuakes(onUpdate, { log = console.log } = {}) {
  async function poll() {
    try {
      const r = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson')
      const j = await r.json()
      quakes = (j.features || [])
        .map((f) => ({
          id: f.id,
          lon: f.geometry?.coordinates?.[0],
          lat: f.geometry?.coordinates?.[1],
          depth: f.geometry?.coordinates?.[2],
          mag: f.properties?.mag,
          time: f.properties?.time,
          place: f.properties?.place,
        }))
        .filter((q) => typeof q.lat === 'number' && typeof q.lon === 'number')
      onUpdate(quakes)
    } catch (e) {
      log(`[quakes] ${e.message}`)
    }
  }
  poll()
  const t = setInterval(poll, 60000)
  return () => clearInterval(t)
}

export function startRadar({ log = console.log } = {}) {
  async function poll() {
    try {
      const r = await fetch('https://api.rainviewer.com/public/weather-maps.json')
      const j = await r.json()
      radar = {
        host: j.host,
        past: (j.radar?.past || []).map((f) => ({ time: f.time, path: f.path })),
        nowcast: (j.radar?.nowcast || []).map((f) => ({ time: f.time, path: f.path })),
      }
    } catch (e) {
      log(`[radar] ${e.message}`)
    }
  }
  poll()
  const t = setInterval(poll, 5 * 60000)
  return () => clearInterval(t)
}
