# ⚡ Lightings

[![Support me on Patreon](https://img.shields.io/badge/Patreon-Support%20my%20work-FF424D?style=flat&logo=patreon&logoColor=white)](https://www.patreon.com/AndersBjarby)

A live global lightning map. Every strike flashes where it hit, then sends an
expanding ring outward — the **thunder wavefront**, travelling at the real speed
of sound (343 m/s). Lingering embers reveal where storms are massing.

Lightning data comes from the community-run [Blitzortung.org](https://www.blitzortung.org)
network, relayed through a small Node backend.

![dark map of the world with glowing lightning strikes and expanding rings]

## Run it

```bash
npm install
npm run dev
```

Then open <http://localhost:5188>.

- Frontend: Vite + MapLibre GL (dark CARTO basemap, no API key needed).
- Backend relay: `http://localhost:8088`, WebSocket at `/live`.

### Source modes

The backend chooses where strikes come from via `BLITZ_MODE`:

| `BLITZ_MODE` | behaviour                                                            |
|--------------|---------------------------------------------------------------------|
| `auto` (default) | Connect to the live Blitzortung feed; if it stays silent for 12 s, light up the simulator so the map is never dead. The sim stops automatically once live strikes arrive. |
| `live`       | Live feed only.                                                     |
| `sim`        | Built-in storm simulator only (great offline / for demos).         |

```bash
BLITZ_MODE=sim npm run dev      # force the simulator
BLITZ_MODE=live npm run dev     # live only
```

## Production

```bash
npm run build      # → dist/
npm start          # serves dist/ + the /live socket on :8088
```

## Features

- **Speed-of-sound rings** — each strike sends a ring out at the real 343 m/s. When
  it sweeps a place, that's when its thunder is heard there (≈3 s per km, the
  "count the seconds" rule). Fades out ~30 km, where thunder goes inaudible.
- **Thunder sound** (toggle) — procedural WebAudio thunder fires the instant a ring
  reaches your "ear" (your located pin, else the map centre): a tight CRACK up
  close, a long low RUMBLE far away. Zoom into a storm to hear it.
- **Click a strike → "How We Know"** — replays the multilateration: the real
  detector stations that heard the bolt light up and pings converge on it.
- **Heatmap** (toggle) — GPU density layer that decays over time; storms glow and
  cool as they pass.
- **Night side** (toggle) — the true day/night terminator from the wall clock;
  strikes on the dark hemisphere bloom brighter as the storm belt follows dusk.
- **Use my location** — drops a pin with a live **thunder-ETA** countdown per strike
  and the NWS **30/30 safety badge** (TAKE COVER ⇄ ALL CLEAR).
- **Relative intensity** — strokes scale with a detection-geometry energy proxy, so
  monster bolts flash fatter than flickers. (Relative, not calibrated kA.)
- **Viewport-driven fetch** — the relay forwards only strikes in your visible area.
- **🌐 Globe view** — a rotating 3D Earth (d3-geo orthographic): drag to spin, scroll
  to zoom, terminator and strikes curving over the sphere.
- **Confidence Halo** — a GDOP error-ellipse from each strike's detector-station
  geometry (shape only, never metres) — the map admits which fixes it trusts.

### Layers fed by other free open data (no API keys)

- **Earthquakes** (USGS) — slow blooming rings on the map/globe; lightning as the
  fastest needle on a planetary vital-signs monitor.
- **Radar** (RainViewer) — animated precipitation radar under the strikes with a
  time scrubber (past → nowcast); watch the electrical core lead the rain.
- **Storm cells** — server-side tracker (gridded clustering + velocity) turns the
  dot-firehose into named, moving cells with drift cones and rising/falling state.
  Neutral IDs only — never a storm-type label.
- **✈ Flights** (OpenSky) — live aircraft around the busiest cells; planes turning
  *away* from a cell glow amber (observed curvature, never a claimed reroute).
  Polled only while the layer is on, to respect the anonymous rate limit.
- **🔥 Fires** (NASA FIRMS) — active fire/thermal detections in your viewport; a
  fire sitting on top of an active lightning cell glows bright amber as a *possible
  lightning ignition* candidate (co-location with active lightning — not a verified
  cause). Needs `FIRMS_MAP_KEY` in `.env`.

### AI analysis (Claude via OpenRouter — set `OPENROUTER_API_KEY` in `.env`)

Design law: **deterministic stats compute the truth; the LLM only ever phrases it.**
No kA, no storm-type labels, no fake per-bolt forecasts.

- **🤖 Storm Desk** — an AI narrator that speaks one wire-service line *only when the
  data changed* ("a cell over the Gulf just tripled its rate"); silent otherwise.
  The server detects events with stats and reverse-geocodes the place; the model
  only writes the sentence. Click the ticker to fly to the cell.
- **🔮 Ask the Planet** — type a question ("any lightning near Stockholm?") and
  Claude answers *and* drives the map (fly-to, drop-pin), using tools over the live
  buffer so every number/place is real. Each answer carries a receipt of the exact
  queries it ran. Scoped honestly to the last ~5 minutes.
- **Personal storm-ETA** — once located, the safety pin uses the cell tracker's
  motion to say "storm heading your way · ~22 min from the SW" (or stays quiet).

Both AI layers run only while their toggle is on, so the API is called only when
you're watching.

## Live feed notes

Blitzortung has no official REST API; the public map streams strikes over a
WebSocket, compressed with a small LZW-style scheme that the relay decodes
(`server/blitzortung.js`). The data is free for non-commercial use — please keep
the Blitzortung attribution visible. A browser can't reach the feed directly
(origin / decode / shared-connection reasons), which is why the Node relay
exists.
