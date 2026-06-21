// Strike-density heatmap layer.
//
// Renders "hot areas" — where lightning is currently concentrated — using
// MapLibre's GPU heatmap. Every strike is kept in a buffer with a timestamp;
// each point's weight DECAYS with age (exponential half-life), so an active
// storm glows hot and an area cools back down once the strikes stop. Points
// older than HEAT_WINDOW_MS are dropped entirely.
//
// The heatmap sits on the map itself (under the canvas FX overlay), so it reads
// as an ambient glow beneath the crisp live flashes and thunder rings.

const HEAT_WINDOW_MS = 30 * 60 * 1000   // keep 30 min of history
const HALF_LIFE_MS = 6 * 60 * 1000      // weight halves every 6 min
const MAX_POINTS = 6000                 // safety cap on buffer size
const SOURCE = 'strike-heat'
const LAYER = 'strike-heat'

export class HeatLayer {
  constructor(map) {
    this.map = map
    this.points = []     // { lon, lat, t }
    this.visible = true
    this._add()
  }

  _add() {
    const m = this.map
    const install = () => {
      if (m.getSource(SOURCE)) return
      m.addSource(SOURCE, { type: 'geojson', data: this._fc() })

      // Insert below the first symbol (label) layer if there is one, so place
      // names stay readable on top of the glow.
      let before
      const layers = m.getStyle().layers || []
      for (const l of layers) {
        if (l.type === 'symbol') { before = l.id; break }
      }

      m.addLayer({
        id: LAYER,
        type: 'heatmap',
        source: SOURCE,
        maxzoom: 11,
        paint: {
          // Per-point weight comes from age decay (set on each feature).
          'heatmap-weight': ['get', 'weight'],
          // Overall intensity ramps up a little as you zoom in.
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 9, 3],
          // Electric ramp: transparent → deep blue → cyan → amber → hot magenta.
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0.0, 'rgba(10, 16, 40, 0)',
            0.2, 'rgba(40, 90, 220, 0.5)',
            0.4, 'rgba(0, 200, 255, 0.7)',
            0.6, 'rgba(120, 240, 180, 0.8)',
            0.8, 'rgba(255, 210, 90, 0.9)',
            1.0, 'rgba(255, 80, 200, 0.95)',
          ],
          // Radius grows with zoom so hot regions stay legible.
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 6, 4, 18, 9, 40],
          // Fade out as you zoom past the maxzoom so individual flashes take over.
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.75, 9, 0.55, 11, 0],
        },
      }, before)
    }

    if (m.isStyleLoaded()) install()
    else m.on('load', install)
  }

  _fc() {
    const now = Date.now()
    return {
      type: 'FeatureCollection',
      features: this.points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { weight: Math.pow(0.5, (now - p.t) / HALF_LIFE_MS) },
      })),
    }
  }

  // Record a strike. `t` is epoch ms (defaults to now).
  add(lon, lat, t) {
    this.points.push({ lon, lat, t: t || Date.now() })
    if (this.points.length > MAX_POINTS) {
      this.points.splice(0, this.points.length - MAX_POINTS)
    }
    this._dirty = true
  }

  // Recompute decayed weights, drop expired points, and push to the GPU.
  // Call on a timer (~1–2 s) — not every animation frame. Skips the (allocation-
  // heavy) rebuild + full GPU upload when nothing changed, but still refreshes
  // periodically so weights keep decaying.
  tick() {
    const now = Date.now()
    const cutoff = now - HEAT_WINDOW_MS
    if (this.points.length && this.points[0].t < cutoff) {
      this.points = this.points.filter((p) => p.t >= cutoff)
      this._dirty = true
    }
    if (!this._dirty && now - (this._lastSet || 0) < 8000) return
    const src = this.map.getSource(SOURCE)
    if (src) src.setData(this._fc())
    this._dirty = false
    this._lastSet = now
  }

  setVisible(on) {
    this.visible = on
    if (this.map.getLayer(LAYER)) {
      this.map.setLayoutProperty(LAYER, 'visibility', on ? 'visible' : 'none')
    }
  }
}
