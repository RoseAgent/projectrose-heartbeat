import { useEffect, useState, useCallback } from 'react'
import { useProjectStore } from '@renderer/stores/useProjectStore'
import styles from './HeartbeatView.module.css'

function formatLogName(filename: string): string {
  const base = filename.replace('.md', '').replace(/T(\d{2})-(\d{2})-(\d{2})-\d+Z/, 'T$1:$2:$3Z')
  try {
    const date = new Date(base)
    return date.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return filename
  }
}

export function HeartbeatView(): JSX.Element {
  const rootPath = useProjectStore((s) => s.rootPath)
  const [logs, setLogs] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [running, setRunning] = useState(false)

  const loadLogs = useCallback(async () => {
    if (!rootPath) return
    const files = await window.api.invoke('rose-heartbeat:getLogs', rootPath) as string[]
    setLogs(files)
    if (files.length > 0 && !selected) setSelected(files[0])
  }, [rootPath, selected])

  useEffect(() => { loadLogs() }, [loadLogs])

  useEffect(() => {
    if (!rootPath || !selected) return
    window.api.invoke('rose-heartbeat:logContent', rootPath, selected)
      .then((c) => setContent(c as string))
      .catch(() => setContent(''))
  }, [rootPath, selected])

  const handleRunNow = async (): Promise<void> => {
    if (!rootPath || running) return
    setRunning(true)
    try {
      await window.api.invoke('rose-heartbeat:run', rootPath)
      await loadLogs()
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Heartbeat Runs</span>
          <button className={styles.runBtn} onClick={handleRunNow} disabled={running}>
            {running ? 'Running…' : 'Run Now'}
          </button>
        </div>
        <div className={styles.logList}>
          {logs.length === 0 ? (
            <div className={styles.empty}>No heartbeat runs yet</div>
          ) : (
            logs.map((log) => (
              <div
                key={log}
                className={`${styles.logItem} ${selected === log ? styles.logItemActive : ''}`}
                onClick={() => setSelected(log)}
              >
                {formatLogName(log)}
              </div>
            ))
          )}
        </div>
      </div>
      <div className={styles.content}>
        {selected ? (
          <pre className={styles.logContent}>{content}</pre>
        ) : (
          <div className={styles.placeholder}>Select a run to view its log</div>
        )}
      </div>
    </div>
  )
}
