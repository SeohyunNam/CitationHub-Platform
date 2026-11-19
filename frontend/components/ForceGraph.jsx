// Always loaded with { ssr: false }
import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import ForceGraph2D from 'react-force-graph-2d'

function paintNode(node, ctx, globalScale) {
  const r = Math.max(3, (node.size || 8) / 2)

  ctx.beginPath()
  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
  ctx.fillStyle = node.color || '#3b82f6'
  ctx.fill()
  ctx.lineWidth   = Math.max(0.5, 1.5 / globalScale)
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.stroke()

  const label = (node.label || '').slice(0, 22)
  if (!label) return
  const showLabel = node.size >= 20 || globalScale >= 0.5

  if (showLabel) {
    const fontSize = Math.max(7, Math.min(11, 9 / globalScale))
    ctx.font             = `${node.size >= 20 ? 'bold ' : ''}${fontSize}px Inter, sans-serif`
    ctx.textAlign        = 'center'
    ctx.textBaseline     = 'top'
    const tw  = ctx.measureText(label).width
    const pad = 2 / globalScale
    const lx  = node.x - tw / 2 - pad
    const ly  = node.y + r + 2 / globalScale
    ctx.fillStyle = 'rgba(255,255,255,0.88)'
    ctx.fillRect(lx, ly, tw + pad * 2, fontSize + pad * 2)
    ctx.fillStyle = '#111827'
    ctx.fillText(label, node.x, ly + pad)
  }
}

function paintLink(link, ctx, globalScale) {
  const src = link.source
  const tgt = link.target
  if (!src?.x || !tgt?.x) return

  const color = typeof link._color === 'string' ? link._color : '#d1d5db'

  // Draw the line
  ctx.beginPath()
  ctx.moveTo(src.x, src.y)
  ctx.lineTo(tgt.x, tgt.y)
  ctx.strokeStyle = color
  ctx.lineWidth   = 1.2 / globalScale
  ctx.stroke()

  // Arrow at target
  const dx    = tgt.x - src.x
  const dy    = tgt.y - src.y
  const dist  = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1) return
  const ux    = dx / dist
  const uy    = dy / dist
  const tgtR  = Math.max(3, (tgt.size || 8) / 2)
  const ax    = tgt.x - ux * tgtR
  const ay    = tgt.y - uy * tgtR
  const aLen  = 6 / globalScale
  const aWid  = 3 / globalScale
  const px    = -uy
  const py    = ux

  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.lineTo(ax - ux * aLen + px * aWid, ay - uy * aLen + py * aWid)
  ctx.lineTo(ax - ux * aLen - px * aWid, ay - uy * aLen - py * aWid)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()

  // Edge label — show when zoomed ≥ 0.4
  const label = link.label || ''
  if (!label || globalScale < 0.4) return

  const mx       = (src.x + tgt.x) / 2
  const my       = (src.y + tgt.y) / 2
  const fontSize = Math.max(5, Math.min(7, 5.5 / globalScale))
  ctx.font       = `${fontSize}px Inter, sans-serif`
  ctx.textAlign  = 'center'
  ctx.textBaseline = 'middle'
  const tw  = ctx.measureText(label).width
  const pad = 1.5 / globalScale

  // Pill background
  ctx.fillStyle = 'rgba(249,250,251,0.92)'
  ctx.beginPath()
  ctx.roundRect
    ? ctx.roundRect(mx - tw / 2 - pad, my - fontSize / 2 - pad, tw + pad * 2, fontSize + pad * 2, 2 / globalScale)
    : ctx.rect(mx - tw / 2 - pad, my - fontSize / 2 - pad, tw + pad * 2, fontSize + pad * 2)
  ctx.fill()

  ctx.fillStyle = '#4b5563'
  ctx.fillText(label, mx, my)
}

export default function ForceGraph({ nodes = [], edges = [], onNodeClick, height = 560 }) {
  const fgRef   = useRef()
  const wrapRef = useRef()
  const fittedRef = useRef(false)
  const [width, setWidth] = useState(800)

  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver(e => setWidth(e[0].contentRect.width || 800))
    ro.observe(wrapRef.current)
    setWidth(wrapRef.current.offsetWidth || 800)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!fgRef.current) return
    fgRef.current.d3Force('charge')?.strength(-220)
    fgRef.current.d3Force('link')?.distance(70).strength(0.4)
    fgRef.current.d3Force('center')?.strength(0.05)
  }, [nodes])

  // Keep the canvas inside its card: the first paint can run before the
  // ResizeObserver reports the real width.
  useEffect(() => {
    fittedRef.current = false
    if (wrapRef.current?.offsetWidth) setWidth(wrapRef.current.offsetWidth)
  }, [nodes])

  useEffect(() => {
    if (!fgRef.current || !nodes.length) return
    const t = setTimeout(() => fgRef.current?.zoomToFit(600, 48), 1200)
    return () => clearTimeout(t)
  }, [nodes])

  const handleClick = useCallback(n => onNodeClick?.(n), [onNodeClick])

  // Rebuilt only when the data changes, so re-renders (e.g. a click) keep the layout.
  const graphData = useMemo(() => ({
    nodes: nodes.map(n => ({ ...n })),
    links: edges.map(e => ({
      source: e.source || e.from,
      target: e.target || e.to,
      label:  e.label  || '',
      _color: typeof e.color === 'string' ? e.color : (e.color?.color || '#d1d5db'),
    })),
  }), [nodes, edges])

  return (
    <div ref={wrapRef} style={{ width: '100%', height }}>
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        width={width}
        height={height}
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => 'replace'}
        nodeRelSize={1}
        linkCanvasObject={paintLink}
        linkCanvasObjectMode={() => 'replace'}
        onNodeClick={handleClick}
        onEngineStop={() => {
          // fit once per dataset; later stops (after dragging a node) keep the user's view
          if (fittedRef.current) return
          fittedRef.current = true
          fgRef.current?.zoomToFit(400, 40)
        }}
        backgroundColor="#ffffff"
        cooldownTicks={200}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
      />
    </div>
  )
}
