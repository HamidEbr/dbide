/** A line that shows how a number has moved over the last few readings. */
export function Sparkline({
  values,
  label,
  format,
}: {
  values: number[]
  label: string
  format: (value: number) => string
}) {
  const width = 160
  const height = 36
  const last = values.at(-1)
  const min = Math.min(...values, 0)
  const max = Math.max(...values, min + 1)
  const points = values
    .map((v, i) => {
      const x = values.length === 1 ? width : (i / (values.length - 1)) * width
      const y = height - 2 - ((v - min) / (max - min)) * (height - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <figure className="redis-spark">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label}: ${last === undefined ? 'no data' : format(last)}`}
        preserveAspectRatio="none"
      >
        {values.length > 1 ? (
          <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        ) : values.length === 1 ? (
          // One reading is a level line, so the box is not empty while the next one is awaited.
          <line
            x1="0"
            x2={width}
            y1={points.split(',')[1]}
            y2={points.split(',')[1]}
            stroke="var(--accent)"
            strokeWidth="1.5"
          />
        ) : null}
      </svg>
      <figcaption>
        <span className="muted">{label}</span>
        <span>{last === undefined ? '–' : format(last)}</span>
      </figcaption>
    </figure>
  )
}
