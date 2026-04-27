import { useSettingsStore } from '@renderer/stores/useSettingsStore'

const INTERVAL_OPTIONS = [1, 2, 5, 10, 15, 30, 60]

const s: Record<string, React.CSSProperties> = {
  section: { marginBottom: 24 },
  title: { fontSize: 11, fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase' as const, color: 'var(--color-text-muted)', marginBottom: 12 },
  card: { display: 'flex', flexDirection: 'column' as const, gap: 14, padding: '14px 16px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md, 6px)', background: 'var(--color-bg-secondary)' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  infoLabel: { fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' },
  desc: { fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2, lineHeight: 1.5 },
  toggle: { width: 36, height: 20, borderRadius: 10, position: 'relative' as const, cursor: 'pointer', transition: 'background 0.2s', border: 'none', flexShrink: 0, padding: 0 },
  thumb: { position: 'absolute' as const, top: 2, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s' },
  intervalGroup: { display: 'flex', gap: 4, flexWrap: 'wrap' as const },
  intervalBtn: { padding: '4px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer', border: '1px solid var(--color-border)', transition: 'background 0.1s' },
}

export function HeartbeatSettings(): JSX.Element {
  const { heartbeatEnabled, heartbeatIntervalMinutes, update } = useSettingsStore()

  return (
    <div>
      <div style={s.section}>
        <div style={s.title}>Heartbeat</div>
        <div style={s.card}>
          <div style={s.row}>
            <div>
              <div style={s.infoLabel}>Enable Heartbeat</div>
              <div style={s.desc}>Automatically process notes and execute due tasks in the background.</div>
            </div>
            <button
              style={{ ...s.toggle, background: heartbeatEnabled ? 'var(--color-accent)' : 'var(--color-border)' }}
              onClick={() => update({ heartbeatEnabled: !heartbeatEnabled })}
              role="switch"
              aria-checked={heartbeatEnabled}
            >
              <span style={{ ...s.thumb, left: heartbeatEnabled ? 18 : 2 }} />
            </button>
          </div>

          <div style={{ ...s.row, opacity: heartbeatEnabled ? 1 : 0.45 }}>
            <div>
              <div style={s.infoLabel}>Run Every</div>
              <div style={s.desc}>How often the heartbeat checks for due tasks.</div>
            </div>
            <div style={s.intervalGroup}>
              {INTERVAL_OPTIONS.map((min) => (
                <button
                  key={min}
                  style={{
                    ...s.intervalBtn,
                    background: heartbeatIntervalMinutes === min ? 'var(--color-accent)' : 'var(--color-bg)',
                    color: heartbeatIntervalMinutes === min ? 'var(--color-text-inverse)' : 'var(--color-text-primary)',
                    borderColor: heartbeatIntervalMinutes === min ? 'var(--color-accent)' : 'var(--color-border)',
                  }}
                  onClick={() => update({ heartbeatIntervalMinutes: min })}
                  disabled={!heartbeatEnabled}
                >
                  {min < 60 ? `${min}m` : '1h'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
