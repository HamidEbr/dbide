export type ThemeSetting = 'system' | 'light' | 'dark'
export type Density = 'compact' | 'default' | 'comfortable'

export interface Settings {
  theme: ThemeSetting
  density: Density
  navigatorOpen: boolean
  inspectorOpen: boolean
  /** Keep a log of the statements that are run. Turn off where queries hold secrets. */
  recordHistory: boolean
  /**
   * SQL autocomplete writes names in full: `schema`.`table` with a short alias after a table, and `alias`.`column`
   * for a column. Off, it writes the bare name.
   */
  sqlFullPaths: boolean
  /** SQL autocomplete writes keywords and functions in capitals. */
  sqlUppercaseKeywords: boolean
}

/** Row height in pixels per density. Mirrors --row-h in tokens.css; the grid needs the number. */
export const DENSITY_ROW_HEIGHT: Record<Density, number> = {
  compact: 24,
  default: 28,
  comfortable: 32,
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  density: 'default',
  navigatorOpen: true,
  inspectorOpen: true,
  recordHistory: true,
  sqlFullPaths: true,
  sqlUppercaseKeywords: true,
}

/** Background colors of the title-bar overlay, kept in step with `--bg-1` in tokens.css. */
export const TITLEBAR_COLORS = {
  light: { color: '#f4f4f6', symbolColor: '#3a3a42' },
  dark: { color: '#1b1c20', symbolColor: '#d4d4da' },
} as const

export const TITLEBAR_HEIGHT = 38
