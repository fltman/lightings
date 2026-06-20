// CAPE "fuel field" — a dim ember layer of convective potential energy beneath
// the strikes, so you can watch storms ignite where the atmosphere was primed.
// Fed by the relay's /cape grid (Open-Meteo). Rendered as a MapLibre heatmap
// weighted by CAPE. Honest framing: CAPE is the FUEL (necessary, not sufficient)
// — high CAPE with no trigger stays quiet. We also expose capeAt() so the HUD
// can show "% of recent strikes over high-fuel ground" against the map baseline.

const SOURCE = 'cape'
const LAYER = 'cape'
const HI = 1000

export class CapeLayer {
  constructor(map) {
    this.map = map
    this.cells = []
    this.hiFrac = 0
    this.visible = false
    this.byKey = new Map()   // "lat,lon" (5° grid) -> cape, for capeAt()
  }

  async load() {
    try {
      const r = await fetch('/cape')
      const j = await r.json()
      this.cells = j.cells || []
      this.hiFrac = j.hiFrac || 0
      this.byKey.clear()
      for (const c of this.cells) this.byKey.set(`${c.lat},${c.lon}`, c.cape)
      if (this.map.getSource(SOURCE)) this.map.getSource(SOURCE).setData(this._fc())
      return this.cells.length > 0
    } catch {
      return false
    }
  }

  _fc() {
    return {
      type: 'FeatureCollection',
      features: this.cells.map((c) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        properties: { w: Math.min(1, c.cape / 2500) },
      })),
    }
  }

  // Nearest 5° grid cell CAPE (J/kg) for a strike location.
  capeAt(lat, lon) {
    const la = Math.round(lat / 5) * 5
    const lo = Math.round(lon / 5) * 5
    return this.byKey.get(`${la},${lo}`) ?? null
  }

  _ensureLayer() {
    const m = this.map
    if (m.getLayer(LAYER)) return
    m.addSource(SOURCE, { type: 'geojson', data: this._fc() })
    const before = m.getLayer('strike-heat') ? 'strike-heat' : undefined
    m.addLayer({
      id: LAYER, type: 'heatmap', source: SOURCE, maxzoom: 10,
      paint: {
        'heatmap-weight': ['get', 'w'],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1.2, 8, 2.2],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0.0, 'rgba(20, 8, 0, 0)',
          0.3, 'rgba(120, 40, 10, 0.35)',
          0.6, 'rgba(220, 110, 30, 0.5)',
          1.0, 'rgba(255, 190, 80, 0.65)',
        ],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 14, 4, 36, 9, 80],
        'heatmap-opacity': 0.55,
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
