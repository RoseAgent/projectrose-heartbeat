import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useProjectStore } from '@renderer/stores/useProjectStore'
import styles from './HeartbeatView.module.css'

interface TaskMeta {
  filename: string
  title: string
  due: string | null
  status: string
  recurrence: string | null
  paused: boolean
  until: string | null
  runs_left: number | null
  createdAt: number
}

interface HeartbeatStatus {
  enabled: boolean
  intervalMinutes: number
  lastRun: number | null
  nextRun: number | null
}

type Tab = 'runs' | 'tasks'

type RecurrencePreset = 'one-time' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'
type CustomUnit = 'm' | 'h' | 'd' | 'w' | 'mo'
type EndMode = 'never' | 'date' | 'count'

const PRESET_TO_RECURRENCE: Record<Exclude<RecurrencePreset, 'one-time' | 'custom'>, string> = {
  hourly: '1h',
  daily: '1d',
  weekly: '1w',
  monthly: '1mo',
}

// ─────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────

// Recover a Date from the log filename (`<ISO timestamp>.md` with `:` and `.`
// replaced with `-` at write time, so `2026-04-29T12-34-56-789Z.md`).
function logFilenameToDate(filename: string): Date | null {
  const base = filename.replace('.md', '').replace(/T(\d{2})-(\d{2})-(\d{2})-\d+Z/, 'T$1:$2:$3Z')
  const d = new Date(base)
  return isNaN(d.getTime()) ? null : d
}

function formatLogName(filename: string): string {
  const d = logFilenameToDate(filename)
  if (!d) return filename
  return d.toLocaleString(undefined, {
    hour: '2-digit', minute: '2-digit'
  })
}

// Local YYYY-MM-DD key, used for grouping & toggle state.
function localDateKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Human-friendly group label: Today / Yesterday / Apr 26, 2026.
function formatGroupLabel(d: Date, today: Date): string {
  const k = localDateKey(d)
  const todayK = localDateKey(today)
  if (k === todayK) return 'Today'
  const yest = new Date(today); yest.setDate(yest.getDate() - 1)
  if (k === localDateKey(yest)) return 'Yesterday'
  const sameYear = d.getFullYear() === today.getFullYear()
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric', weekday: 'short' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch { return iso }
}

function formatRecurrencePhrase(recurrence: string | null): string {
  if (!recurrence) return ''
  const m = recurrence.match(/^(\d+)(mo|m|h|d|w)$/i)
  if (!m) return recurrence
  const n = parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  const noun =
    unit === 'm' ? (n === 1 ? 'minute' : 'minutes') :
    unit === 'h' ? (n === 1 ? 'hour' : 'hours') :
    unit === 'd' ? (n === 1 ? 'day' : 'days') :
    unit === 'w' ? (n === 1 ? 'week' : 'weeks') :
    (n === 1 ? 'month' : 'months')
  return n === 1 ? `every ${noun.replace(/s$/, '')}` : `every ${n} ${noun}`
}

// Subtitle shown on each task list row.
function formatTaskSubtitle(t: TaskMeta): string {
  if (t.status === 'completed') return 'completed'
  if (!t.recurrence) {
    return t.due ? `due ${formatDateTime(t.due)}${new Date(t.due) < new Date() ? ' (overdue)' : ''}` : 'no due date'
  }
  // recurring
  const cadence = formatRecurrencePhrase(t.recurrence)
  const parts: string[] = [cadence]
  if (t.paused) {
    parts.push('paused')
  } else if (t.due) {
    parts.push(`next run ${formatDateTime(t.due)}`)
  }
  if (t.until) parts.push(`stops ${formatDateTime(t.until)}`)
  if (typeof t.runs_left === 'number') parts.push(`${t.runs_left} run${t.runs_left === 1 ? '' : 's'} left`)
  return parts.join(' · ')
}

// Convert a Date to the local-time string format <input type="datetime-local"> expects.
function toLocalInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Compact relative time. Negative diff = past ("3m ago"); positive = future ("in 3m").
// Diff is milliseconds.
function formatRelative(diffMs: number): string {
  const past = diffMs < 0
  const abs = Math.abs(diffMs)
  if (abs < 1_000) return past ? 'just now' : 'any moment'
  const sec = Math.round(abs / 1_000)
  if (sec < 60) return past ? `${sec}s ago` : `in ${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return past ? `${min}m ago` : `in ${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return past ? `${hr}h ago` : `in ${hr}h`
  const day = Math.round(hr / 24)
  return past ? `${day}d ago` : `in ${day}d`
}

function recurrenceFromForm(preset: RecurrencePreset, customN: number, customUnit: CustomUnit): string | null {
  if (preset === 'one-time') return null
  if (preset === 'custom') {
    const n = Math.max(1, Math.floor(customN))
    return `${n}${customUnit}`
  }
  return PRESET_TO_RECURRENCE[preset]
}

// Inverse of recurrenceFromForm — used when populating the edit form.
function recurrenceToForm(rec: string | null): { preset: RecurrencePreset; customN: number; customUnit: CustomUnit } {
  if (!rec) return { preset: 'one-time', customN: 1, customUnit: 'd' }
  const matched = (Object.keys(PRESET_TO_RECURRENCE) as Array<keyof typeof PRESET_TO_RECURRENCE>)
    .find((k) => PRESET_TO_RECURRENCE[k] === rec)
  if (matched) return { preset: matched as RecurrencePreset, customN: 1, customUnit: 'd' }
  const m = rec.match(/^(\d+)(mo|m|h|d|w)$/i)
  if (m) return { preset: 'custom', customN: parseInt(m[1], 10), customUnit: m[2].toLowerCase() as CustomUnit }
  return { preset: 'one-time', customN: 1, customUnit: 'd' }
}

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────

export function HeartbeatView(): JSX.Element {
  const rootPath = useProjectStore((s) => s.rootPath)
  const [tab, setTab] = useState<Tab>('runs')

  // Runs state
  const [logs, setLogs] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<HeartbeatStatus | null>(null)
  const [now, setNow] = useState<number>(Date.now())
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const groupsInitializedRef = useRef(false)

  // Group logs by local date, newest day first; logs within a day stay in the
  // mtime-sorted order they came back in.
  const groupedLogs = useMemo(() => {
    const today = new Date()
    const groups = new Map<string, { key: string; label: string; logs: string[]; sortDate: Date }>()
    for (const filename of logs) {
      const d = logFilenameToDate(filename)
      if (!d) continue
      const key = localDateKey(d)
      const existing = groups.get(key)
      if (existing) {
        existing.logs.push(filename)
      } else {
        groups.set(key, {
          key,
          label: formatGroupLabel(d, today),
          logs: [filename],
          sortDate: new Date(d.getFullYear(), d.getMonth(), d.getDate()),
        })
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.sortDate.getTime() - a.sortDate.getTime())
  }, [logs])

  // Auto-open the newest group on first load. After that, the user is in
  // control — toggling state isn't reset by polling refreshes.
  useEffect(() => {
    if (groupedLogs.length === 0 || groupsInitializedRef.current) return
    groupsInitializedRef.current = true
    setOpenGroups(new Set([groupedLogs[0].key]))
  }, [groupedLogs])

  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [])

  // Tasks state
  const [tasks, setTasks] = useState<TaskMeta[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingFilename, setEditingFilename] = useState<string | null>(null)  // null = create
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [taskDue, setTaskDue] = useState(toLocalInput(new Date()))
  const [recurrencePreset, setRecurrencePreset] = useState<RecurrencePreset>('one-time')
  const [customN, setCustomN] = useState<number>(1)
  const [customUnit, setCustomUnit] = useState<CustomUnit>('d')
  const [endMode, setEndMode] = useState<EndMode>('never')
  const [endDate, setEndDate] = useState<string>(toLocalInput(new Date()))
  const [endCount, setEndCount] = useState<number>(10)
  const [creating, setCreating] = useState(false)

  const loadLogs = useCallback(async () => {
    if (!rootPath) return
    const files = await window.api.invoke('rose-heartbeat:getLogs', rootPath) as string[]
    setLogs(files)
    setSelected((cur) => {
      if (cur && files.includes(cur)) return cur
      return files[0] ?? null
    })
  }, [rootPath])

  const loadTasks = useCallback(async () => {
    if (!rootPath) return
    const list = await window.api.invoke('rose-heartbeat:listTasks', rootPath) as TaskMeta[]
    setTasks(list)
  }, [rootPath])

  const loadStatus = useCallback(async () => {
    if (!rootPath) return
    try {
      const s = await window.api.invoke('rose-heartbeat:getStatus') as HeartbeatStatus
      setStatus(s)
    } catch { /* extension not loaded yet */ }
  }, [rootPath])

  useEffect(() => { loadLogs() }, [loadLogs])
  useEffect(() => { loadTasks() }, [loadTasks])
  useEffect(() => { loadStatus() }, [loadStatus])

  // While the Runs tab is visible, refresh status every 15s and tick the
  // displayed countdown every second. Both are cheap and let the user see
  // "Next run: in 3m 42s" decrement live.
  useEffect(() => {
    if (tab !== 'runs') return
    const statusTimer = setInterval(loadStatus, 15_000)
    const nowTimer = setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      clearInterval(statusTimer)
      clearInterval(nowTimer)
    }
  }, [tab, loadStatus])

  useEffect(() => {
    if (!rootPath || !selected) { setContent(''); return }
    window.api.invoke('rose-heartbeat:logContent', rootPath, selected)
      .then((c) => setContent(c as string))
      .catch(() => setContent(''))
  }, [rootPath, selected])

  const handleRunNow = async (): Promise<void> => {
    if (!rootPath || running) return
    setRunning(true)
    try {
      await window.api.invoke('rose-heartbeat:run', rootPath)
      await Promise.all([loadLogs(), loadTasks(), loadStatus()])
    } finally {
      setRunning(false)
    }
  }

  const resetForm = useCallback((): void => {
    setEditingFilename(null)
    setTaskTitle('')
    setTaskDescription('')
    setTaskDue(toLocalInput(new Date()))
    setRecurrencePreset('one-time')
    setCustomN(1)
    setCustomUnit('d')
    setEndMode('never')
    setEndDate(toLocalInput(new Date()))
    setEndCount(10)
    setShowForm(false)
  }, [])

  const beginNewTask = (): void => {
    resetForm()
    setShowForm(true)
  }

  // Populate the form from an existing task and switch into edit mode.
  const beginEditTask = useCallback(async (filename: string) => {
    if (!rootPath) return
    const raw = await window.api.invoke('rose-heartbeat:taskContent', rootPath, filename) as string

    // Parse frontmatter on the renderer side (small lift; mirrors main.ts parser).
    const fm: Record<string, string> = {}
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---/)
    if (m) {
      for (const line of m[1].split('\n')) {
        const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$/)
        if (km) fm[km[1]] = km[2].trim()
      }
    }
    const bodyMatch = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/)
    const body = bodyMatch ? bodyMatch[1] : raw
    // Strip ## Memory section and the leading # heading from description
    const memoryIdx = body.search(/^## Memory\b/m)
    const beforeMemory = memoryIdx === -1 ? body : body.slice(0, memoryIdx)
    const description = beforeMemory.replace(/^\s*#\s+.*\n+/, '').trim()

    const recForm = recurrenceToForm(fm.recurrence ?? null)

    setEditingFilename(filename)
    setTaskTitle(fm.title ?? '')
    setTaskDescription(description)
    setTaskDue(fm.due ? toLocalInput(new Date(fm.due)) : toLocalInput(new Date()))
    setRecurrencePreset(recForm.preset)
    setCustomN(recForm.customN)
    setCustomUnit(recForm.customUnit)

    if (fm.until) {
      setEndMode('date')
      setEndDate(toLocalInput(new Date(fm.until)))
    } else if (fm.runs_left && /^\d+$/.test(fm.runs_left)) {
      setEndMode('count')
      setEndCount(parseInt(fm.runs_left, 10))
    } else {
      setEndMode('never')
    }

    setShowForm(true)
  }, [rootPath])

  const handleSaveTask = async (): Promise<void> => {
    if (!rootPath || creating) return
    const title = taskTitle.trim()
    if (!title) return
    setCreating(true)
    try {
      const dueIso = taskDue ? new Date(taskDue).toISOString() : new Date().toISOString()
      const recurrence = recurrenceFromForm(recurrencePreset, customN, customUnit)
      const isRecurring = !!recurrence
      const until = isRecurring && endMode === 'date' && endDate ? new Date(endDate).toISOString() : null
      const runs_left = isRecurring && endMode === 'count' ? Math.max(1, Math.floor(endCount)) : null

      if (editingFilename) {
        await window.api.invoke('rose-heartbeat:updateTask', rootPath, editingFilename, {
          title,
          description: taskDescription,
          due: dueIso,
          recurrence,
          until,
          runs_left,
        })
      } else {
        await window.api.invoke('rose-heartbeat:createTask', rootPath, {
          title,
          description: taskDescription,
          due: dueIso,
          recurrence,
          until,
          runs_left,
        })
      }
      resetForm()
      await loadTasks()
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteTask = async (filename: string): Promise<void> => {
    if (!rootPath) return
    await window.api.invoke('rose-heartbeat:deleteTask', rootPath, filename)
    await loadTasks()
  }

  const handleTogglePaused = async (t: TaskMeta): Promise<void> => {
    if (!rootPath) return
    await window.api.invoke('rose-heartbeat:updateTask', rootPath, t.filename, { paused: !t.paused })
    await loadTasks()
  }

  const isRecurringForm = recurrencePreset !== 'one-time'
  const formTitleText = editingFilename ? 'Edit task' : 'New scheduled task'
  const submitBtnText = creating
    ? (editingFilename ? 'Saving…' : 'Creating…')
    : (editingFilename ? 'Save changes' : 'Create task')

  return (
    <div className={styles.container}>
      <div className={styles.sidebar}>
        <div className={styles.tabs}>
          <button
            className={`${styles.tabBtn} ${tab === 'runs' ? styles.tabBtnActive : ''}`}
            onClick={() => setTab('runs')}
          >
            Runs
          </button>
          <button
            className={`${styles.tabBtn} ${tab === 'tasks' ? styles.tabBtnActive : ''}`}
            onClick={() => setTab('tasks')}
          >
            Tasks{tasks.filter((t) => t.status !== 'completed').length > 0
              ? ` (${tasks.filter((t) => t.status !== 'completed').length})`
              : ''}
          </button>
        </div>

        {tab === 'runs' && (
          <>
            <div className={styles.sidebarHeader}>
              <span className={styles.sidebarTitle}>Heartbeat Runs</span>
              <button className={styles.runBtn} onClick={handleRunNow} disabled={running}>
                {running ? 'Running…' : 'Run Now'}
              </button>
            </div>
            {status && (
              <div className={styles.statusLine}>
                {!status.enabled ? (
                  <span className={styles.statusDisabled}>Heartbeat disabled</span>
                ) : (
                  <>
                    <span>
                      Last:{' '}
                      <span className={styles.statusValue}>
                        {status.lastRun ? formatRelative(status.lastRun - now) : '—'}
                      </span>
                    </span>
                    <span className={styles.statusSep}>·</span>
                    <span>
                      Next:{' '}
                      <span className={styles.statusValue}>
                        {status.nextRun ? formatRelative(status.nextRun - now) : '—'}
                      </span>
                    </span>
                    <span className={styles.statusSep}>·</span>
                    <span className={styles.statusInterval}>every {status.intervalMinutes}m</span>
                  </>
                )}
              </div>
            )}
            <div className={styles.logList}>
              {logs.length === 0 ? (
                <div className={styles.empty}>No heartbeat runs yet</div>
              ) : (
                groupedLogs.map((group) => {
                  const open = openGroups.has(group.key)
                  return (
                    <div key={group.key} className={styles.logGroup}>
                      <button
                        type="button"
                        className={styles.groupHeader}
                        onClick={() => toggleGroup(group.key)}
                        aria-expanded={open}
                      >
                        <span className={`${styles.groupChevron} ${open ? styles.groupChevronOpen : ''}`}>▸</span>
                        <span className={styles.groupLabel}>{group.label}</span>
                        <span className={styles.groupCount}>{group.logs.length}</span>
                      </button>
                      {open && group.logs.map((log) => (
                        <div
                          key={log}
                          className={`${styles.logItem} ${styles.logItemNested} ${selected === log ? styles.logItemActive : ''}`}
                          onClick={() => setSelected(log)}
                        >
                          {formatLogName(log)}
                        </div>
                      ))}
                    </div>
                  )
                })
              )}
            </div>
          </>
        )}

        {tab === 'tasks' && (
          <>
            <div className={styles.sidebarHeader}>
              <span className={styles.sidebarTitle}>Scheduled Tasks</span>
              <button
                className={styles.runBtn}
                onClick={() => (showForm ? resetForm() : beginNewTask())}
              >
                {showForm ? 'Cancel' : '+ New'}
              </button>
            </div>
            <div className={styles.taskList}>
              {tasks.length === 0 ? (
                <div className={styles.empty}>No tasks scheduled</div>
              ) : (
                tasks.map((t) => {
                  const recurring = !!t.recurrence
                  const isCompleted = t.status === 'completed'
                  return (
                    <div
                      key={t.filename}
                      className={`${styles.taskItem} ${isCompleted ? styles.taskItemDone : ''}`}
                    >
                      <div className={styles.taskRow}>
                        <span className={styles.taskTitle} title={t.title}>{t.title}</span>
                        <div className={styles.taskRowBtns}>
                          {!isCompleted && (
                            <button
                              className={styles.taskIconBtn}
                              onClick={() => beginEditTask(t.filename)}
                              title="Edit task"
                              aria-label="Edit task"
                            >
                              ✎
                            </button>
                          )}
                          {recurring && !isCompleted && (
                            <button
                              className={styles.taskIconBtn}
                              onClick={() => handleTogglePaused(t)}
                              title={t.paused ? 'Resume task' : 'Pause task'}
                              aria-label={t.paused ? 'Resume task' : 'Pause task'}
                            >
                              {t.paused ? '▶' : '⏸'}
                            </button>
                          )}
                          <button
                            className={styles.taskDeleteBtn}
                            onClick={() => handleDeleteTask(t.filename)}
                            title="Delete task"
                            aria-label="Delete task"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                      <div className={styles.taskMeta}>
                        <span>{formatTaskSubtitle(t)}</span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </>
        )}
      </div>

      <div className={styles.content}>
        {tab === 'runs' && (
          selected ? (
            <pre className={styles.logContent}>{content}</pre>
          ) : (
            <div className={styles.placeholder}>Select a run to view its log</div>
          )
        )}

        {tab === 'tasks' && (
          showForm ? (
            <div className={styles.taskForm}>
              <h2 className={styles.taskFormTitle}>{formTitleText}</h2>
              <p className={styles.taskFormHint}>
                {editingFilename
                  ? 'Changes save in place; recurring tasks keep their Memory section intact.'
                  : 'The agent will execute this on the next heartbeat tick after the due time.'}
              </p>

              <label className={styles.fieldLabel}>Title</label>
              <input
                className={styles.fieldInput}
                type="text"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="e.g. Refresh project README"
                autoFocus
              />

              <label className={styles.fieldLabel}>Description</label>
              <textarea
                className={styles.fieldTextarea}
                value={taskDescription}
                onChange={(e) => setTaskDescription(e.target.value)}
                placeholder="Describe what the agent should do…"
                rows={8}
              />

              <label className={styles.fieldLabel}>Due (or next run)</label>
              <input
                className={styles.fieldInput}
                type="datetime-local"
                value={taskDue}
                onChange={(e) => setTaskDue(e.target.value)}
              />

              <label className={styles.fieldLabel}>Recurrence</label>
              <select
                className={styles.fieldInput}
                value={recurrencePreset}
                onChange={(e) => setRecurrencePreset(e.target.value as RecurrencePreset)}
              >
                <option value="one-time">One-time</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="custom">Custom…</option>
              </select>

              {recurrencePreset === 'custom' && (
                <div className={styles.customIntervalRow}>
                  <span className={styles.customIntervalLabel}>Every</span>
                  <input
                    className={styles.customIntervalNum}
                    type="number"
                    min={1}
                    value={customN}
                    onChange={(e) => setCustomN(parseInt(e.target.value, 10) || 1)}
                  />
                  <select
                    className={styles.customIntervalUnit}
                    value={customUnit}
                    onChange={(e) => setCustomUnit(e.target.value as CustomUnit)}
                  >
                    <option value="m">minutes</option>
                    <option value="h">hours</option>
                    <option value="d">days</option>
                    <option value="w">weeks</option>
                    <option value="mo">months</option>
                  </select>
                </div>
              )}

              {isRecurringForm && (
                <>
                  <label className={styles.fieldLabel}>Stop after</label>
                  <div className={styles.endModeRadios}>
                    <label className={styles.radioRow}>
                      <input
                        type="radio"
                        checked={endMode === 'never'}
                        onChange={() => setEndMode('never')}
                      />
                      <span>Never</span>
                    </label>
                    <label className={styles.radioRow}>
                      <input
                        type="radio"
                        checked={endMode === 'date'}
                        onChange={() => setEndMode('date')}
                      />
                      <span>Date</span>
                      <input
                        className={styles.radioInlineInput}
                        type="datetime-local"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                        disabled={endMode !== 'date'}
                      />
                    </label>
                    <label className={styles.radioRow}>
                      <input
                        type="radio"
                        checked={endMode === 'count'}
                        onChange={() => setEndMode('count')}
                      />
                      <span>After</span>
                      <input
                        className={styles.radioInlineNum}
                        type="number"
                        min={1}
                        value={endCount}
                        onChange={(e) => setEndCount(parseInt(e.target.value, 10) || 1)}
                        disabled={endMode !== 'count'}
                      />
                      <span>runs</span>
                    </label>
                  </div>
                </>
              )}

              <div className={styles.taskFormActions}>
                <button className={styles.cancelBtn} onClick={resetForm} disabled={creating}>
                  Cancel
                </button>
                <button
                  className={styles.runBtn}
                  onClick={handleSaveTask}
                  disabled={creating || !taskTitle.trim()}
                >
                  {submitBtnText}
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.placeholder}>
              {tasks.length === 0
                ? 'No tasks yet — click + New to schedule one.'
                : 'Click a task\'s ✎ to edit, or + New to schedule another.'}
            </div>
          )
        )}
      </div>
    </div>
  )
}
