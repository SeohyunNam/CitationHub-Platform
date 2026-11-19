import { scaleSqrt } from 'd3-scale'

export const POINT_RADIUS = [1.6, 15]
export const LABEL_FONT   = 9
export const MAX_BUBBLES  = 400

// How many of the top points compete for a label, per unit of zoom. Restricting
// candidates by rank keeps a visible label meaningful: without it, a minor place with
// empty space around it gets named while a major one inside a dense cluster does not.
const LABEL_CANDIDATES = 45
const LABEL_PAD        = 2
// A label may sit across a small dot — its halo keeps it readable — but not across a
// bubble large enough to be read as a data point of its own.
const BUBBLE_AVOID_RADIUS = 8

// Where a label may sit relative to its bubble: beside it, then diagonally, and finally
// at a wider offset. The extra room matters most for the busiest institutions, which are
// exactly the ones hemmed in — Cambridge and Boston, or Beijing's twenty-two, crowd each
// other out of every position close in.
const LABEL_DIRECTIONS = [
  [1, 0], [-1, 0], [0, -1], [0, 1],
  [1, -1], [-1, -1], [1, 1], [-1, 1],
]
const LABEL_RINGS = [0, 12]

// Institution names run long ("Research Institute of Petroleum Exploration and
// Development"), and a label that wide crowds out every neighbour. Over-eager cutting is
// worse than a wide label though: what distinguishes one institution from another sits at
// the end of its name, so eight University of California campuses collapse into one label
// long before the name gets short. The budget is therefore generous, and the full name
// stays in the tooltip.
const LABEL_MAX_CHARS = 40
// Words that read as dangling when a name is cut right after them.
const CONNECTORS = new Set(['of', 'and', 'for', 'the', 'at', 'in', 'on', 'de', '&'])

// Points that share coordinates — every affiliation in one city does, since the dataset
// locates them no more precisely — are fanned out so each keeps its own hover target and
// label anchor. Successive points step round by the golden angle at a radius growing with
// sqrt(rank), the sunflower packing, which stays compact as a cluster grows.
//
// Offsets are screen pixels, like the radii, so a cluster covers the same few pixels at
// every zoom level. That is deliberate: the fan-out is a drawing device, not a position,
// and holding it to a fixed pixel size means the ground distance it implies shrinks the
// further in the user zooms, converging on the one coordinate the data actually gives.
// Spreading in map units instead would look tidier when zoomed in while claiming these
// institutions sit hundreds of kilometres apart.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const SPREAD_STEP  = 6

/** Shorten a name to something that fits on the map, cutting on a word boundary. */
export function shortLabel(name) {
  const clean = String(name || '').replace(/^the\s+/i, '').trim()
  if (clean.length <= LABEL_MAX_CHARS) return clean

  const kept = []
  let length = 0
  for (const word of clean.split(/\s+/)) {
    const grown = length === 0 ? word.length : length + 1 + word.length
    if (grown > LABEL_MAX_CHARS) break
    kept.push(word)
    length = grown
  }
  while (kept.length > 1 &&
         CONNECTORS.has(kept[kept.length - 1].replace(/\W/g, '').toLowerCase())) {
    kept.pop()
  }
  // A single word longer than the budget still has to be cut mid-word.
  const head = kept.length > 0 ? kept.join(' ') : clean.slice(0, LABEL_MAX_CHARS)
  return `${head.replace(/[,;:&\-–]+$/, '').trimEnd()}\u2026`
}

/**
 * Bubble radius in screen pixels for a paper count, shared by the map and the legend so
 * the two cannot drift apart.
 */
export function bubbleRadius(maxCount) {
  return scaleSqrt().domain([1, Math.max(maxCount, 1)]).range(POINT_RADIUS)
}

/**
 * Project map points onto the map, largest first, with a bubble radius by paper count.
 *
 * `projection` must be the map's own projection so bubbles line up with the countries;
 * read it from react-simple-maps' map context rather than building a second one.
 *
 * `r`, `ox` and `oy` are screen pixels, not map units: bubbles keep a constant on-screen
 * size so that zooming pulls a dense cluster apart instead of magnifying it into one
 * blob. Feed the result to `placePoints` to turn them into coordinates for a zoom level.
 */
export function projectPoints(points, projection) {
  const top = [...points]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_BUBBLES)
  const radius = bubbleRadius(Math.max(...top.map(p => p.count), 1))
  const colocated = new Map()

  return top.reduce((acc, point) => {
    const xy = projection([point.lon, point.lat])
    if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return acc

    const cluster = `${xy[0].toFixed(3)},${xy[1].toFixed(3)}`
    const rank    = colocated.get(cluster) || 0
    colocated.set(cluster, rank + 1)
    const spread = SPREAD_STEP * Math.sqrt(rank)
    const angle  = rank * GOLDEN_ANGLE

    acc.push({
      ...point,
      // Names repeat across places — Cambridge US / Cambridge UK, an institute with
      // branches — so the place is part of the identity.
      key: [point.name, point.city, point.country].filter(Boolean).join('|'),
      label: shortLabel(point.name),
      cluster,
      x: xy[0],
      y: xy[1],
      ox: spread * Math.cos(angle),
      oy: spread * Math.sin(angle),
      r: radius(point.count),
    })
    return acc
  }, [])
}

/** Resolve each point to map coordinates (`px`, `py`) for the current zoom level. */
export function placePoints(points, zoom) {
  return points.map(p => ({ ...p, px: p.x + p.ox / zoom, py: p.y + p.oy / zoom }))
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Pick which bubbles get a text label, densest first.
 *
 * Labels render at a constant on-screen size, so their footprint in map coordinates
 * shrinks as `zoom` grows — that, plus a candidate pool that widens with zoom, is what
 * lets more names appear as the user zooms in. Each point is tried to the right of its
 * bubble first, then left, above and below; a point is left unlabelled when none of the
 * four positions fits within the map without touching another label or a large bubble.
 */
export function layoutLabels(points, zoom, width, height) {
  const limit = Math.min(points.length, Math.round(LABEL_CANDIDATES * zoom))
  const pad   = LABEL_PAD / zoom
  const obstacles = points
    .filter(p => p.r >= BUBBLE_AVOID_RADIUS)
    .map(p => {
      const r = p.r / zoom
      return { cluster: p.cluster, x: p.px - r, y: p.py - r, w: r * 2, h: r * 2 }
    })

  const placed = []
  const taken  = []
  for (let i = 0; i < limit; i++) {
    const point = points[i]
    const w = (point.label.length * LABEL_FONT * 0.58) / zoom
    const h = (LABEL_FONT * 1.5) / zoom

    const positions = []
    if (point.centered) {
      positions.push({
        x: point.px - w / 2,
        y: point.py - h / 2,
        anchor: 'middle',
      })
    }
    for (const ring of LABEL_RINGS) {
      const gap = (point.r + 2 + ring) / zoom
      for (const [dx, dy] of LABEL_DIRECTIONS) {
        const cx = point.px + dx * gap
        const cy = point.py + dy * gap
        positions.push({
          x: dx > 0 ? cx : dx < 0 ? cx - w : cx - w / 2,
          y: dy > 0 ? cy : dy < 0 ? cy - h : cy - h / 2,
          anchor: dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle',
        })
      }
    }

    for (const pos of positions) {
      if (pos.x < 0 || pos.x + w > width) continue
      if (pos.y < 0 || pos.y + h > height) continue
      const test = { x: pos.x - pad, y: pos.y - pad, w: w + 2 * pad, h: h + 2 * pad }
      if (taken.some(b => overlaps(b, test))) continue
      // A point's own cluster is exempt: the bubbles of one city sit on top of each other
      // by construction, so treating siblings as obstacles would leave the largest
      // institutions in Beijing or Boston permanently unlabelled. Labels still never
      // overlap each other, and their halo keeps them legible over a bubble.
      if (obstacles.some(b => b.cluster !== point.cluster && overlaps(b, test))) continue

      taken.push({ x: pos.x, y: pos.y, w, h })
      placed.push({
        ...point,
        labelX: pos.anchor === 'start' ? pos.x
              : pos.anchor === 'end'   ? pos.x + w
              : pos.x + w / 2,
        labelY: pos.y + h * 0.75,
        labelAnchor: pos.anchor,
      })
      break
    }
  }
  return placed
}

/**
 * A point inside a country that a label can sit on: the centroid of its largest polygon.
 *
 * Taking the largest ring, not the whole MultiPolygon, keeps the United States in the
 * contiguous forty-eight and France in Europe rather than halfway to Alaska or Guyana.
 * A handful of shapes still land in the sea or on ice even then; LABEL_ANCHORS pins those.
 */
const LABEL_ANCHORS = {
  124: [-96, 56],     // Canada — the geometric centre sits in Hudson Bay
  152: [-71, -33],    // Chile — a long strip whose centroid is offshore
  250: [2.5, 46.5],   // France — otherwise pulled by overseas territories
  578: [9, 61],       // Norway — otherwise pulled by Svalbard
  643: [90, 62],      // Russia — otherwise sits in eastern Siberia
  840: [-98, 39.5],   // United States
}

function ringArea(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return Math.abs(a / 2)
}

function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j]
    const [x1, y1] = ring[i]
    const f = x0 * y1 - x1 * y0
    a += f
    cx += (x0 + x1) * f
    cy += (y0 + y1) * f
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length || 1
    return ring.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0])
  }
  return [cx / (3 * a), cy / (3 * a)]
}

function polygonsOf(geometry) {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  return []
}

export function countryLabelLonLat(geo) {
  const pinned = LABEL_ANCHORS[Number(geo.id)]
  if (pinned) return pinned

  let best = null
  let bestArea = -1
  for (const polygon of polygonsOf(geo.geometry)) {
    const ring = polygon[0]
    if (!ring || ring.length < 3) continue
    const area = ringArea(ring)
    if (area > bestArea) {
      bestArea = area
      best = ring
    }
  }
  return best ? ringCentroid(best) : null
}

/**
 * Turn country shapes that have a paper count into the same point records the bubble
 * layers feed to `layoutLabels`. `r` is zero — there is no bubble to stand off — and
 * `centered` asks the layout to try sitting on the country before stepping aside.
 */
export function projectCountries(geographies, countMap, nameOf, projection) {
  const points = []
  for (const geo of geographies) {
    const iso = String(geo.id)
    const count = countMap[iso] || 0
    if (count <= 0) continue
    const name = nameOf(iso)
    if (!name) continue
    const lonlat = countryLabelLonLat(geo)
    if (!lonlat) continue
    const xy = projection(lonlat)
    if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue
    points.push({
      name,
      count,
      key: iso,
      label: shortLabel(name),
      cluster: iso,
      centered: true,
      x: xy[0], y: xy[1], ox: 0, oy: 0, r: 0,
    })
  }
  return points.sort((a, b) => b.count - a.count)
}

/** Paper counts to show in the legend to explain the area scale, always ascending. */
export function legendSteps(maxCount) {
  const candidates = [1, Math.round(maxCount / 10), maxCount]
  return [...new Set(candidates.filter(n => n >= 1))].sort((a, b) => a - b)
}
