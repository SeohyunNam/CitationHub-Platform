// Dynamically imported with { ssr: false }
import { useMemo, useState } from 'react'
import {
  ComposableMap, Geographies, Geography, ZoomableGroup, useMapContext,
} from 'react-simple-maps'
import { scaleQuantize } from 'd3-scale'
import {
  POINT_RADIUS, LABEL_FONT, projectPoints, projectCountries, placePoints, layoutLabels,
  legendSteps, bubbleRadius,
} from '../lib/mapLayer'

const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json'

// ISO 3166-1 numeric → country name (subset covering common academic countries)
const ISO_TO_NAME = {
  4:'Afghanistan',8:'Albania',12:'Algeria',24:'Angola',32:'Argentina',36:'Australia',40:'Austria',
  50:'Bangladesh',56:'Belgium',68:'Bolivia',76:'Brazil',100:'Bulgaria',116:'Cambodia',120:'Cameroon',
  124:'Canada',152:'Chile',156:'China',170:'Colombia',191:'Croatia',192:'Cuba',196:'Cyprus',
  203:'Czech Republic',208:'Denmark',818:'Egypt',233:'Estonia',231:'Ethiopia',246:'Finland',
  250:'France',276:'Germany',288:'Ghana',300:'Greece',320:'Guatemala',344:'Hong Kong',
  348:'Hungary',356:'India',360:'Indonesia',364:'Iran',368:'Iraq',372:'Ireland',
  376:'Israel',380:'Italy',388:'Jamaica',392:'Japan',400:'Jordan',398:'Kazakhstan',
  404:'Kenya',408:'North Korea',410:'South Korea',414:'Kuwait',418:'Laos',422:'Lebanon',
  428:'Latvia',440:'Lithuania',442:'Luxembourg',458:'Malaysia',484:'Mexico',504:'Morocco',
  528:'Netherlands',554:'New Zealand',566:'Nigeria',578:'Norway',586:'Pakistan',275:'Palestine',
  604:'Peru',608:'Philippines',616:'Poland',620:'Portugal',634:'Qatar',642:'Romania',
  643:'Russia',682:'Saudi Arabia',686:'Senegal',694:'Sierra Leone',703:'Slovakia',705:'Slovenia',
  706:'Somalia',710:'South Africa',724:'Spain',144:'Sri Lanka',752:'Sweden',756:'Switzerland',
  760:'Syria',158:'Taiwan',764:'Thailand',788:'Tunisia',792:'Turkey',800:'Uganda',
  804:'Ukraine',784:'United Arab Emirates',826:'United Kingdom',840:'United States',
  858:'Uruguay',860:'Uzbekistan',862:'Venezuela',704:'Vietnam',887:'Yemen',716:'Zimbabwe',
}

// Reverse: name → ISO numeric (as string to match topojson feature ids)
const NAME_TO_ISO = {}
Object.entries(ISO_TO_NAME).forEach(([iso, name]) => { NAME_TO_ISO[name] = String(iso) })

// Extra aliases for common Scopus/WoS name variants
const ALIASES = {
  'USA': '840', 'UK': '826', 'England': '826', 'Scotland': '826', 'Wales': '826',
  'United States of America': '840', 'PRC': '156', "People's Republic of China": '156',
  'Republic of Korea': '410', 'Korea': '410', 'Czech Republic': '203', 'Czechia': '203',
  'Hong Kong SAR': '344', 'Macao': '446', 'Macau': '446',
  'Taiwan, Province of China': '158', 'Chinese Taipei': '158',
  'Iran, Islamic Republic of': '364', 'Syrian Arab Republic': '760',
  'Russian Federation': '643', 'Bolivia, Plurinational State of': '68',
  'Venezuela, Bolivarian Republic of': '862', 'Viet Nam': '704',
  'Lao PDR': '418', "Lao People's Democratic Republic": '418',
  'Moldova': '498', 'Republic of Moldova': '498',
  'Tanzania': '834', 'United Republic of Tanzania': '834',
}

function lookupIso(name) {
  return NAME_TO_ISO[name] || ALIASES[name] || null
}

const COLOR_RANGE = ['#dbeafe', '#93c5fd', '#60a5fa', '#2563eb', '#1e40af', '#1e3a8a']

// One entry per bubble view; `countries` is absent because it paints the land itself.
// Fills match the colour each measure already carries in the bar charts below the map.
const POINT_STYLES = {
  cities:       { fill: '#8b5cf6', stroke: '#6d28d9', count: 'text-violet-700' },
  affiliations: { fill: '#f59e0b', stroke: '#b45309', count: 'text-amber-600' },
}

// Landmass fill for the bubble views, where countries are backdrop rather than measurement.
const LAND_FILL = '#dde5ee'
// Square that fits the largest legend bubble sitting on its baseline.
const LEGEND_SWATCH = POINT_RADIUS[1] * 2 + 2

/**
 * Bubbles and their labels. Rendered inside ComposableMap so it can read the map's own
 * projection, which keeps the bubbles aligned with the country shapes.
 */
function PointLayer({ points, zoom, style, onHover }) {
  const { projection, width, height } = useMapContext()

  const projected = useMemo(
    () => projectPoints(points, projection), [points, projection])
  const placed = useMemo(
    () => placePoints(projected, zoom), [projected, zoom])
  const labels = useMemo(
    () => layoutLabels(placed, zoom, width, height), [placed, zoom, width, height])

  return (
    <>
      {placed.map(point => (
        <circle
          key={point.key}
          cx={point.px}
          cy={point.py}
          r={point.r / zoom}
          fill={style.fill}
          fillOpacity={0.5}
          stroke={style.stroke}
          strokeWidth={0.5 / zoom}
          style={{ cursor: 'pointer' }}
          onMouseEnter={() => onHover({
            name:  point.name,
            place: [point.city, point.country].filter(Boolean).join(', '),
            count: point.count,
          })}
          onMouseLeave={() => onHover(null)}
        />
      ))}

      {labels.map(point => (
        <text
          key={`label-${point.key}`}
          x={point.labelX}
          y={point.labelY}
          textAnchor={point.labelAnchor}
          fontSize={LABEL_FONT / zoom}
          fill="#3f3f46"
          stroke="#f8fafc"
          strokeWidth={2.5 / zoom}
          paintOrder="stroke"
          style={{ pointerEvents: 'none', fontWeight: 500 }}
        >
          {point.label}
        </text>
      ))}
    </>
  )
}

/**
 * Country names on the choropleth. Same collision-avoiding labels as the bubble layers,
 * sitting on each country's interior rather than beside a point.
 */
function CountryLabelLayer({ geographies, countMap, zoom }) {
  const { projection, width, height } = useMapContext()

  const projected = useMemo(
    () => projectCountries(geographies, countMap, iso => ISO_TO_NAME[Number(iso)], projection),
    [geographies, countMap, projection])
  const placed = useMemo(
    () => placePoints(projected, zoom), [projected, zoom])
  const labels = useMemo(
    () => layoutLabels(placed, zoom, width, height), [placed, zoom, width, height])

  return labels.map(point => (
    <text
      key={`label-${point.key}`}
      x={point.labelX}
      y={point.labelY}
      textAnchor={point.labelAnchor}
      fontSize={LABEL_FONT / zoom}
      fill="#3f3f46"
      stroke="#f8fafc"
      strokeWidth={2.5 / zoom}
      paintOrder="stroke"
      style={{ pointerEvents: 'none', fontWeight: 500 }}
    >
      {point.label}
    </text>
  ))
}

export default function ChoroplethMap({ countryCounts = [], points = [], view = 'countries' }) {
  const [tooltip, setTooltip] = useState(null)
  const [zoom,    setZoom]    = useState(1)

  const pointStyle = POINT_STYLES[view]
  const showPoints = Boolean(pointStyle) && points.length > 0

  const countMap = useMemo(() => {
    const map = {}
    countryCounts.forEach(c => {
      const iso = lookupIso(c.name)
      if (iso) map[iso] = (map[iso] || 0) + c.count
    })
    return map
  }, [countryCounts])

  const maxCount   = Math.max(...Object.values(countMap), 1)
  const colorScale = scaleQuantize().domain([1, maxCount]).range(COLOR_RANGE)

  const maxPointCount = useMemo(
    () => points.reduce((m, p) => Math.max(m, p.count), 0), [points])
  const pointRadius = useMemo(() => bubbleRadius(maxPointCount), [maxPointCount])

  return (
    <div className="relative w-full" style={{ background: '#f8fafc' }}>
      <ComposableMap
        projectionConfig={{ rotate: [-10, 0, 0], scale: 150 }}
        style={{ width: '100%', height: 'auto' }}
      >
        <ZoomableGroup
          zoom={1}
          minZoom={0.8}
          maxZoom={12}
          onMoveEnd={({ zoom: k }) => setZoom(k)}
        >
          <Geographies geography={GEO_URL}>
            {({ geographies }) =>
              <>
                {geographies.map(geo => {
                const isoId = String(geo.id)
                const count = countMap[isoId] || 0
                const name  = ISO_TO_NAME[Number(isoId)] || 'Unknown'
                // In a bubble view countries are context rather than the measurement, so
                // they stay flat and let the bubbles carry the signal.
                const fill  = showPoints
                  ? LAND_FILL
                  : (count > 0 ? colorScale(count) : '#e2e8f0')

                return (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    fill={fill}
                    stroke="#fff"
                    strokeWidth={0.4}
                    style={{
                      default: { outline: 'none' },
                      hover: showPoints
                        ? { fill: LAND_FILL, outline: 'none' }
                        : { fill: count > 0 ? '#1d4ed8' : '#cbd5e1', outline: 'none', cursor: 'pointer' },
                      pressed: { outline: 'none' },
                    }}
                    onMouseEnter={showPoints ? undefined : () => setTooltip({ name, count })}
                    onMouseLeave={showPoints ? undefined : () => setTooltip(null)}
                  />
                )
              })}
              {!showPoints && (
                <CountryLabelLayer
                  geographies={geographies} countMap={countMap} zoom={zoom}
                />
              )}
              </>
            }
          </Geographies>

          {showPoints && (
            <PointLayer
              points={points} zoom={zoom} style={pointStyle} onHover={setTooltip}
            />
          )}
        </ZoomableGroup>
      </ComposableMap>

      {/* Tooltip */}
      {tooltip && (
        <div className="absolute bottom-4 left-4 bg-white border border-gray-200 rounded-lg px-3 py-2 shadow text-xs pointer-events-none">
          <span className="font-semibold text-gray-800">{tooltip.name}</span>
          {tooltip.place && <span className="text-gray-400 ml-1">{tooltip.place}</span>}
          {tooltip.count > 0
            ? <span className={`ml-2 font-bold ${pointStyle ? pointStyle.count : 'text-brand-700'}`}>
                {tooltip.count.toLocaleString()} papers
              </span>
            : <span className="text-gray-400 ml-2">no data</span>
          }
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-4 right-4 bg-white border border-gray-200 rounded-lg px-3 py-2 shadow">
        <p className="text-xs text-gray-400 mb-1.5">Papers</p>
        {showPoints ? (
          <div className="flex items-end gap-3">
            {legendSteps(maxPointCount).map(n => {
              const r = pointRadius(n)
              return (
                <span key={n} className="flex flex-col items-center gap-1">
                  <svg width={LEGEND_SWATCH} height={LEGEND_SWATCH}>
                    <circle
                      cx={LEGEND_SWATCH / 2} cy={LEGEND_SWATCH - r} r={r}
                      fill={pointStyle.fill} fillOpacity={0.5}
                      stroke={pointStyle.stroke} strokeWidth={0.5}
                    />
                  </svg>
                  <span className="text-xs text-gray-400">{n.toLocaleString()}</span>
                </span>
              )
            })}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-400">0</span>
            {COLOR_RANGE.map((c, i) => (
              <span key={i} className="w-5 h-3 rounded-sm" style={{ background: c }} />
            ))}
            <span className="text-xs text-gray-400">{maxCount}</span>
          </div>
        )}
      </div>
    </div>
  )
}
