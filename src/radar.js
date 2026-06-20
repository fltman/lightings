// RainViewer precipitation-radar layer with a time scrubber.
//
// Adds a MapLibre raster layer beneath the strikes; the scrubber swaps the
// source's tiles across the past frames (~2 h) into the nowcast (~+30 min).
// Forecast frames are flagged so observation and nowcast are never confused.
// Free, no key (Universal-Blue colour scheme, max zoom 7 on the free tier).

const SOURCE = 'rainviewer'
const LAYER = 'rainviewer'

export class RadarLayer {
  constructor(map) {
    this.map = map
    this.host = ''
    this.frames = []      // [{ time, path, forecast }]
    this.pastCount = 0
    this.idx = 0
    this.visible = false
    this.onFrame = null   // (frame, idx, total) => void, for the scrubber UI
  }

  async load() {
    try {
      const r = await fetch('/radar')
      const j = await r.json()
      if (!j.host) return false
      this.host = j.host
      const past = (j.past || []).map((f) => ({ ...f, forecast: false }))
      const now = (j.nowcast || []).map((f) => ({ ...f, forecast: true }))
      this.frames = [...past, ...now]
      this.pastCount = past.length
      this.idx = Math.max(0, past.length - 1)   // latest observed frame
      return this.frames.length > 0
    } catch {
      return false
    }
  }

  _url(frame) {
    // {host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth_snow}.png
    return `${this.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`
  }

  _ensureLayer() {
    const m = this.map
    if (m.getLayer(LAYER)) return
    const frame = this.frames[this.idx]
    if (!frame) return
    m.addSource(SOURCE, { type: 'raster', tiles: [this._url(frame)], tileSize: 256, maxzoom: 7 })
    // Below the strike heatmap if present, else below the first label layer.
    let before
    if (m.getLayer('strike-heat')) before = 'strike-heat'
    else for (const l of m.getStyle().layers || []) { if (l.type === 'symbol') { before = l.id; break } }
    m.addLayer({
      id: LAYER, type: 'raster', source: SOURCE,
      paint: { 'raster-opacity': 0.5 },
    }, before)
  }

  _applyFrame() {
    const m = this.map
    const frame = this.frames[this.idx]
    if (!frame || !m.getSource(SOURCE)) return
    const src = m.getSource(SOURCE)
    if (src.setTiles) src.setTiles([this._url(frame)])
    // Forecast frames render dimmer so they read as "not yet observed".
    if (m.getLayer(LAYER)) m.setPaintProperty(LAYER, 'raster-opacity', frame.forecast ? 0.32 : 0.5)
    if (this.onFrame) this.onFrame(frame, this.idx, this.frames.length)
  }

  setVisible(on) {
    this.visible = on
    if (on) {
      this._ensureLayer()
      this._applyFrame()
    }
    if (this.map.getLayer(LAYER)) {
      this.map.setLayoutProperty(LAYER, 'visibility', on ? 'visible' : 'none')
    }
  }

  setIndex(i) {
    this.idx = Math.max(0, Math.min(this.frames.length - 1, i | 0))
    this._applyFrame()
  }
}
