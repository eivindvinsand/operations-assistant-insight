import type { ReactNode } from 'react'
import { marked } from 'marked'
import Box from '@intility/bifrost-react/Box'
import Grid from '@intility/bifrost-react/Grid'
import Inline from '@intility/bifrost-react/Inline'
import Icon from '@intility/bifrost-react/Icon'

export const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact' })

export const dayFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit' })

export const tooltipContentStyle = {
  background: 'var(--bfc-base-3)',
  border: '1px solid var(--bfc-base-c-dimmed)',
  borderRadius: 8,
  color: 'var(--bfc-base-c)',
}
export const tooltipItemStyle = { color: 'var(--bfc-base-c)' }
export const tooltipLabelStyle = { color: 'var(--bfc-base-c-2)' }

export function formatDuration(seconds: number): string {
  if (!seconds) return '0s'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest}s`
}

export function Markdown({ text }: { text: string }) {
  return <div className="bf-elements" dangerouslySetInnerHTML={{ __html: marked.parse(text, { async: false }) }} />
}

export function SectionBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box padding radius background="base-2">
      <h5 className="bf-h5" style={{ marginBottom: 16 }}>
        {title}
      </h5>
      {children}
    </Box>
  )
}

export function Tile({
  label,
  icon,
  value,
  sub,
  onClick,
  alert,
}: {
  label: string
  icon: Parameters<typeof Icon>[0]['icon']
  value: string
  sub?: string
  onClick?: () => void
  alert?: boolean
}) {
  return (
    <Box
      padding
      radius
      background="base-2"
      style={onClick ? { cursor: 'pointer', transition: 'box-shadow 0.15s' } : undefined}
      {...(onClick ? { onClick } : {})}
    >
      <Inline gap={12} align="center">
        <Box
          radius="full"
          background="base"
          style={{ width: 40, height: 40, display: 'grid', placeItems: 'center' }}
        >
          <Icon icon={icon} className={alert ? 'bfc-alert bf-large' : 'bfc-base-2 bf-large'} />
        </Box>
        <Inline.Stretch>
          <small className="bfc-base-2">{label}</small>
          <div>
            <span className="bf-h5">{value}</span>
            {sub && (
              <>
                {' '}
                <small className="bfc-base-2">{sub}</small>
              </>
            )}
          </div>
        </Inline.Stretch>
      </Inline>
    </Box>
  )
}

export const BREAKDOWN_COLORS = [
  'var(--bfc-chill)',
  'var(--bfc-attn)',
  'var(--bfc-warning)',
  'var(--bfc-success)',
  'var(--bfc-brand)',
  'var(--bfc-base-c-2)',
]

export function BreakdownBars({
  items,
  onSelect,
}: {
  items: { label: string; count: number }[]
  onSelect: (label: string) => void
}) {
  const max = items[0]?.count ?? 1
  return (
    <Grid gap={8}>
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          onClick={() => onSelect(item.label)}
          style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
        >
          <Inline align="center" gap={12}>
            <Inline.Stretch>
              <small className="bfc-base-2" style={{ display: 'block', marginBottom: 2 }}>
                {item.label}
              </small>
              <div style={{ height: 6, background: 'var(--bfc-base-3)', borderRadius: 3, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${(item.count / max) * 100}%`,
                    background: BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length],
                  }}
                />
              </div>
            </Inline.Stretch>
            <small className="bfc-base-2">{item.count}</small>
          </Inline>
        </button>
      ))}
    </Grid>
  )
}

/** Pivots {day, count, ...}[] rows into one row per day with one column per series key,
 * the shape recharts wants for a multi-series bar/line chart over time. */
export function pivotDaily<T extends { day: string; count: number }>(
  rows: T[],
  keyOf: (row: T) => string,
): Record<string, number | string>[] {
  const byDay = new Map<string, Record<string, number | string>>()
  for (const row of rows) {
    const existing = byDay.get(row.day) ?? { label: dayFormatter.format(new Date(row.day)) }
    existing[keyOf(row)] = row.count
    byDay.set(row.day, existing)
  }
  return [...byDay.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)))
}
