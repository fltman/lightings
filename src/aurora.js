// Auroral oval (NOAA OVATION) — a green glow over the high-latitude night
// hemisphere. On the flat map it's a MapLibre heatmap; the globe draws it as
// glowing points (see globe.js). Honest counterpoint to lightning: a completely
// different, silent electrical sky where it almost never thunders.

const SOURCE = 'aurora'
const LAYER = 'aurora'

export class AuroraLayer {
  constructor(map) {
    this.map = map
    this.points = []
    this.visible = false
  }

  async load() {
    try {
      const r = await fetch('/aurora')
      const j = await r.json()
      this.points = j.aurora || []
      if (this.map.getSource(SOURCE)) this.map.getSource(SOURCE).setData(this._fc())
      return this.points.length > 0
    } catch {
      return false
    }
  }

  _fc() {
    return {
      type: 'FeatureCollection',
      features: this.points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { w: Math.min(1, p.val / 60) },
      })),
    }
  }

  _ensureLayer() {
    const m = this.map
    if (m.getLayer(LAYER)) return
    m.addSource(SOURCE, { type: 'geojson', data: this._fc() })
    const before = m.getLayer('strike-heat') ? 'strike-heat' : undefined
    m.addLayer({
      id: LAYER, type: 'heatmap', source: SOURCE, maxzoom: 9,
      paint: {
        'heatmap-weight': ['get', 'w'],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1.4, 6, 2.4],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0.0, 'rgba(10, 30, 15, 0)',
          0.3, 'rgba(40, 200, 120, 0.35)',
          0.6, 'rgba(80, 255, 170, 0.55)',
          1.0, 'rgba(170, 255, 210, 0.7)',
        ],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 16, 4, 40, 8, 90],
        'heatmap-opacity': 0.6,
      },
    }, before)
  }

  setVisible(on) {
    this.visible = on
    if (on) this._ensureLayer()
    if (this.map.getLayer(LAYER)) {
      this.map.setLayoutProperty(LAYER, 'visibility', on ? 'visible' : 'none')
    }
  }
}
