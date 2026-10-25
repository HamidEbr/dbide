import { useState } from 'react'
import type { Density, ThemeSetting } from '@shared/settings'
import { Button, Segmented } from '@/components/ui'
import { revealScripts } from '@/features/sql/library'
import { useHistory } from '@/state/history'
import { useData } from '@/state/data'
import { notify } from '@/state/notices'

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const DENSITIES: { value: Density; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'comfortable', label: 'Comfortable' },
]

export function SettingsView() {
  const settings = useData((state) => state.settings)
  const info = useData((state) => state.info)
  const updateSettings = useData((state) => state.updateSettings)
  const [confirmClear, setConfirmClear] = useState(false)

  return (
    <div className="view">
      <header className="view-header">
        <h1>Settings</h1>
      </header>

      <section className="form-section">
        <h2>Appearance</h2>
        <div className="setting-row">
          <div>
            <h3>Theme</h3>
            <p className="muted">System follows your operating system's light or dark mode.</p>
          </div>
          <Segmented<ThemeSetting>
            label="Theme"
            value={settings.theme}
            options={THEMES}
            onChange={(theme) => void updateSettings({ theme })}
          />
        </div>
        <div className="setting-row">
          <div>
            <h3>Density</h3>
            <p className="muted">Row height in trees, tables, and lists.</p>
          </div>
          <Segmented<Density>
            label="Density"
            value={settings.density}
            options={DENSITIES}
            onChange={(density) => void updateSettings({ density })}
          />
        </div>
      </section>

      <section className="form-section">
        <h2>Scripts and history</h2>
        <div className="setting-row">
          <div>
            <h3>Scripts folder</h3>
            <p className="muted">
              Every SQL tab is a .sql file here. Put files in it and they show up in the Scripts
              list.
            </p>
            {info ? <p className="mono selectable muted">{info.scriptsDir}</p> : null}
          </div>
          <Button onClick={() => revealScripts(null)}>Show folder</Button>
        </div>
        <div className="setting-row">
          <div>
            <h3>Keep a history of the statements you run</h3>
            <p className="muted">
              Stored on this computer only. Turn it off if your queries contain secrets.
            </p>
          </div>
          <Segmented<'on' | 'off'>
            label="Query history"
            value={settings.recordHistory ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(value) => void updateSettings({ recordHistory: value === 'on' })}
          />
        </div>
        <div className="setting-row">
          <div>
            <h3>Clear query history</h3>
            <p className="muted">Removes every recorded statement. Scripts are not touched.</p>
          </div>
          {confirmClear ? (
            <span className="history-confirm">
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmClear(false)
                  void useHistory
                    .getState()
                    .clear()
                    .then(() => notify('Cleared the query history.'))
                }}
              >
                Clear it
              </Button>
              <Button variant="ghost" onClick={() => setConfirmClear(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button onClick={() => setConfirmClear(true)}>Clear history…</Button>
          )}
        </div>
      </section>

      {info ? (
        <section className="form-section">
          <h2>About</h2>
          <dl className="facts selectable">
            <dt>Version</dt>
            <dd>{info.version}</dd>
            <dt>Electron</dt>
            <dd>{info.electron}</dd>
            <dt>Node.js</dt>
            <dd>{info.node}</dd>
            <dt>SQLite</dt>
            <dd>{info.sqlite}</dd>
            <dt>Data folder</dt>
            <dd className="mono">{info.dataDir}</dd>
          </dl>
        </section>
      ) : null}
    </div>
  )
}
