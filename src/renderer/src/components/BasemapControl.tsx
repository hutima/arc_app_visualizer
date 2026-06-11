interface Props {
  theme: 'dark' | 'light'
  onChange: (theme: 'dark' | 'light') => void
}

/** Light/dark basemap switch; the choice persists in settings.json. */
export function BasemapControl({ theme, onChange }: Props): React.JSX.Element {
  return (
    <section className="panel">
      <h2>Basemap</h2>
      <select
        className="detail-select"
        value={theme}
        onChange={(e) => onChange(e.target.value as 'dark' | 'light')}
        aria-label="basemap theme"
      >
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
      <p className="hint">
        Basemap streets are dimmed so tracks stay prominent (roadDimOpacity in settings.json).
      </p>
    </section>
  )
}
