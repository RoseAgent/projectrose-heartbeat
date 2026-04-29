import { ipcMain } from 'electron'
import { join } from 'path'
import { readdir, readFile, writeFile, stat, unlink, mkdir, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { execSync } from 'child_process'

interface ExtCtx {
  rootPath: string
  getSettings: () => Promise<Record<string, unknown>>
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
  broadcast: (channel: string, data: unknown) => void
  registerTools: (tools: unknown[]) => void
  runBackgroundAgent: (prompt: string, systemPrompt: string) => Promise<string>
  registerHooks: (hooks: unknown[]) => void
  openAgentSession: (opts: { systemPrompt: string }) => { send: (text: string) => Promise<string>; close: () => void }
}

// Marker written into idle ("Nothing to process") run logs so they can be
// safely identified and pruned without false positives from agent output.
const IDLE_LOG_MARKER = '<!-- rose-heartbeat:idle -->'

// System prompt the heartbeat extension uses for its background agent runs.
// Lives here in the extension, NOT in the host — the host has no business
// knowing what a "deferred work queue" is.
const HEARTBEAT_SYSTEM_PROMPT =
  'You are an autonomous agent processing a deferred work queue.\n' +
  'Execute every item completely. Do not ask for confirmation — just do the work.\n' +
  'Use available tools (read_file, write_file, run_command, list_directory, plus any extension tools) to accomplish each task.\n'

// Heading the agent maintains in every recurring task body.
const MEMORY_HEADING = '## Memory'
const MEMORY_PLACEHOLDER =
  '_The agent maintains this section. It summarises what this task has done ' +
  'across past runs and is fed back to the agent on the next run as context._'

// ─────────────────────────────────────────────────────────────────────────
// Path & filesystem helpers
// ─────────────────────────────────────────────────────────────────────────

function prPath(rootPath: string, ...parts: string[]): string {
  return join(rootPath, '.projectrose', ...parts)
}

async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((f) => f.endsWith('.md') && f !== '.gitkeep')
  } catch {
    return []
  }
}

function isValidTaskFilename(filename: string): boolean {
  return !filename.includes('/') && !filename.includes('\\') && !filename.includes('..') && filename.endsWith('.md')
}

function assertValidTaskFilename(filename: string): void {
  if (!isValidTaskFilename(filename)) throw new Error('Invalid task filename')
}

// ─────────────────────────────────────────────────────────────────────────
// Frontmatter
// ─────────────────────────────────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$/)
    if (m) result[m[1]] = m[2].trim()
  }
  return result
}

function bodyAfterFrontmatter(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/)
  return match ? match[1] : content
}

function formatYamlValue(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v).replace(/[\r\n]+/g, ' ')
}

// Rewrites only the YAML frontmatter block of a task file in place.
// Body — including any agent-maintained `## Memory` section — is preserved
// verbatim. Patch values:
//  - string / number / boolean: set or update the key
//  - null / undefined: remove the key (no-op if it wasn't there)
async function rewriteFrontmatter(
  tasksDir: string,
  filename: string,
  patch: Record<string, string | number | boolean | null | undefined>
): Promise<void> {
  const fullPath = join(tasksDir, filename)
  const content = await readFile(fullPath, 'utf-8')

  // Capture: opening fence newline + fmText + closing fence + everything after
  const m = content.match(/^---\s*\n([\s\S]*?)\n---(\r?\n[\s\S]*)?$/)
  if (!m) return  // file isn't a frontmatter doc; refuse to edit

  const fmText = m[1]
  const afterFm = m[2] ?? '\n'

  const ordered: { key: string; value: string }[] = []
  for (const line of fmText.split('\n')) {
    const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (km) ordered.push({ key: km[1], value: km[2].trim() })
  }
  const existingKeys = new Set(ordered.map((o) => o.key))

  const out: { key: string; value: string }[] = []
  for (const { key, value } of ordered) {
    if (key in patch) {
      const pv = patch[key]
      if (pv === null || pv === undefined) continue   // remove
      out.push({ key, value: formatYamlValue(pv) })
    } else {
      out.push({ key, value })
    }
  }
  for (const [key, pv] of Object.entries(patch)) {
    if (existingKeys.has(key)) continue
    if (pv === null || pv === undefined) continue
    out.push({ key, value: formatYamlValue(pv) })
  }

  const newFm = out.map((r) => `${r.key}: ${r.value}`).join('\n')
  const newContent = `---\n${newFm}\n---${afterFm}`
  await writeFile(fullPath, newContent, 'utf-8')
}

// ─────────────────────────────────────────────────────────────────────────
// Recurrence
// ─────────────────────────────────────────────────────────────────────────

type RecurrenceUnit = 'm' | 'h' | 'd' | 'w' | 'mo'

interface Recurrence {
  n: number
  unit: RecurrenceUnit
}

// Grammar: <positive integer><unit> with units ∈ {m, h, d, w, mo}.
// "mo" must be checked before "m" so it isn't shadowed by the single-char rule.
function parseRecurrence(raw: string | null | undefined): Recurrence | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d+)(mo|m|h|d|w)$/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return { n, unit: m[2].toLowerCase() as RecurrenceUnit }
}

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate()
}

// Returns d + r. For minutes/hours/days/weeks, plain ms math. For months,
// uses calendar arithmetic with last-day-of-month clamping so that
// Jan 31 + 1mo → Feb 28 (or 29 in leap years), not the JS default of Mar 3.
function addRecurrence(d: Date, r: Recurrence): Date {
  if (r.unit === 'm') return new Date(d.getTime() + r.n * 60_000)
  if (r.unit === 'h') return new Date(d.getTime() + r.n * 3_600_000)
  if (r.unit === 'd') return new Date(d.getTime() + r.n * 86_400_000)
  if (r.unit === 'w') return new Date(d.getTime() + r.n * 7 * 86_400_000)
  // months
  const day = d.getDate()
  const totalMonths = d.getMonth() + r.n
  const targetYear = d.getFullYear() + Math.floor(totalMonths / 12)
  const targetMonth = ((totalMonths % 12) + 12) % 12
  const maxDay = lastDayOfMonth(targetYear, targetMonth)
  const result = new Date(d)
  result.setFullYear(targetYear, targetMonth, Math.min(day, maxDay))
  return result
}

// Drift-free roll: starting from `due`, advance by `r` repeatedly until the
// new date is strictly greater than `now`. Bails after a hard safety bound to
// guard against zero-or-negative-advance recurrences (shouldn't happen given
// parseRecurrence, but cheap insurance).
function rollDueForward(due: Date, r: Recurrence, now: Date): Date {
  let next = new Date(due.getTime())
  for (let i = 0; i < 100_000; i++) {
    if (next.getTime() > now.getTime()) return next
    const advanced = addRecurrence(next, r)
    if (advanced.getTime() <= next.getTime()) return next  // not advancing; bail
    next = advanced
  }
  return next
}

// ─────────────────────────────────────────────────────────────────────────
// Task model
// ─────────────────────────────────────────────────────────────────────────

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

async function readTaskMeta(tasksDir: string, filename: string): Promise<TaskMeta | null> {
  try {
    const fullPath = join(tasksDir, filename)
    const [content, st] = await Promise.all([readFile(fullPath, 'utf-8'), stat(fullPath)])
    const fm = parseFrontmatter(content)
    const body = bodyAfterFrontmatter(content)
    const titleMatch = body.match(/^#\s+(.+)$/m)
    const runsLeftRaw = fm.runs_left
    const runsLeft = runsLeftRaw !== undefined && /^-?\d+$/.test(runsLeftRaw) ? parseInt(runsLeftRaw, 10) : null
    return {
      filename,
      title: (fm.title || titleMatch?.[1] || filename.replace(/\.md$/, '')).trim(),
      due: fm.due ?? null,
      status: fm.status || 'pending',
      recurrence: fm.recurrence ?? null,
      paused: fm.paused === 'true',
      until: fm.until ?? null,
      runs_left: runsLeft,
      createdAt: st.birthtimeMs || st.mtimeMs
    }
  } catch {
    return null
  }
}

async function filterDueTasks(files: string[], tasksDir: string): Promise<string[]> {
  const now = new Date()
  const due: string[] = []
  for (const file of files) {
    try {
      const content = await readFile(join(tasksDir, file), 'utf-8')
      const fm = parseFrontmatter(content)
      if (fm.status === 'completed') continue
      if (fm.paused === 'true') continue
      if (!fm.due) continue
      const dueDate = new Date(fm.due)
      if (!isNaN(dueDate.getTime()) && dueDate <= now) due.push(file)
    } catch { /* skip unreadable files */ }
  }
  return due
}

// Run after the agent finishes. For each recurring task in this batch:
//  - Advance `due` drift-free until > now
//  - Reset `status` to pending (overrides whatever the agent wrote)
//  - Decrement `runs_left` if present; mark completed when it hits 0
//  - Mark completed if the new `due` is past `until`
//  - Body (incl. agent-maintained ## Memory) is preserved verbatim
async function rolloverRecurringTasks(
  tasksDir: string,
  dueFilenames: string[],
  now: Date
): Promise<void> {
  for (const filename of dueFilenames) {
    try {
      const meta = await readTaskMeta(tasksDir, filename)
      if (!meta || !meta.recurrence) continue
      const r = parseRecurrence(meta.recurrence)
      if (!r) continue

      const oldDue = meta.due ? new Date(meta.due) : now
      const baseDue = isNaN(oldDue.getTime()) ? now : oldDue
      const nextDue = rollDueForward(baseDue, r, now)

      let nextStatus: 'pending' | 'completed' = 'pending'
      const patch: Record<string, string | number | boolean | null> = {
        due: nextDue.toISOString(),
      }

      if (typeof meta.runs_left === 'number') {
        const decremented = Math.max(0, meta.runs_left - 1)
        patch.runs_left = decremented
        if (decremented === 0) nextStatus = 'completed'
      }
      if (meta.until) {
        const untilDate = new Date(meta.until)
        if (!isNaN(untilDate.getTime()) && nextDue > untilDate) {
          nextStatus = 'completed'
        }
      }
      patch.status = nextStatus

      await rewriteFrontmatter(tasksDir, filename, patch)
    } catch { /* skip individual rollover failures */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Heartbeat run
// ─────────────────────────────────────────────────────────────────────────

function buildPrompt(rootPath: string, dueTasks: string[], hasRecurring: boolean): string {
  const parts = [
    `You are processing the deferred work queue for the project at: ${rootPath}`,
    '',
    'Your job:',
    '',
    `## Execute Due Tasks (${dueTasks.length} tasks in .projectrose/heartbeat/tasks/)`,
    ...dueTasks.map((t) => `- ${t}`),
    '',
    'For each due task: read the file, execute the described task using available tools,',
    'then update the status field in the YAML frontmatter to "completed".',
  ]
  if (hasRecurring) {
    parts.push(
      '',
      '## Recurring task upkeep',
      '',
      'Some of these tasks are recurring (they have a `recurrence:` field in frontmatter and a `## Memory` section in the body).',
      'For each recurring task:',
      '- Read the existing `## Memory` section — it summarises what this task has done in prior runs.',
      '- Use it to decide what is worth doing this run; avoid repeating completed work.',
      '- After completing the task, REWRITE the entire `## Memory` section with an updated summary',
      '  that includes today\'s run. Keep it under ~10 lines; summarise older entries together when needed.',
      '- Do NOT modify the YAML frontmatter on recurring tasks — the heartbeat will roll `due` and `status` itself.',
    )
  }
  parts.push('', 'Report concisely what you did for each item.')
  return parts.join('\n')
}

async function pruneIdleLogs(logsDir: string, keepFilename: string | null): Promise<void> {
  try {
    const files = await readdir(logsDir)
    const mdFiles = files.filter((f) => f.endsWith('.md') && f !== '.gitkeep' && f !== keepFilename)
    await Promise.all(mdFiles.map(async (f) => {
      try {
        const content = await readFile(join(logsDir, f), 'utf-8')
        if (content.includes(IDLE_LOG_MARKER)) {
          await unlink(join(logsDir, f)).catch(() => {})
        }
      } catch { /* ignore */ }
    }))
  } catch { /* ignore */ }
}

async function runHeartbeat(rootPath: string, ctx: ExtCtx): Promise<string> {
  const tasksDir = prPath(rootPath, 'heartbeat', 'tasks')
  const logsDir = prPath(rootPath, 'heartbeat', 'logs')
  const allTasks = await listMdFiles(tasksDir)
  const dueTasks = await filterDueTasks(allTasks, tasksDir)

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logFilename = `${timestamp}.md`
  const logPath = join(logsDir, logFilename)

  if (dueTasks.length === 0) {
    const body = `# Heartbeat — ${new Date().toLocaleString()}\n\n${IDLE_LOG_MARKER}\n\nNothing to process.\n`
    await writeFile(logPath, body, 'utf-8').catch(() => {})
    await pruneIdleLogs(logsDir, logFilename)
    return 'Nothing to process.'
  }

  // Detect recurring up-front so we can shape the prompt accordingly.
  const dueMetas = await Promise.all(dueTasks.map((f) => readTaskMeta(tasksDir, f)))
  const hasRecurring = dueMetas.some((m) => m && m.recurrence)

  let agentResult = ''
  let agentError: Error | null = null
  try {
    agentResult = await ctx.runBackgroundAgent(
      buildPrompt(rootPath, dueTasks, hasRecurring),
      HEARTBEAT_SYSTEM_PROMPT,
    )
  } catch (err) {
    agentError = err as Error
    agentResult = `(agent errored)\n\n${agentError.message ?? String(agentError)}`
  }

  // Always roll recurring tasks forward, even on agent failure — keeps a
  // permanently-broken task from looping every tick and burning API.
  await rolloverRecurringTasks(tasksDir, dueTasks, new Date()).catch(() => {})

  await writeFile(logPath, `# Heartbeat — ${new Date().toLocaleString()}\n\n${agentResult}\n`, 'utf-8').catch(() => {})
  await pruneIdleLogs(logsDir, logFilename)

  try {
    const status = execSync('git status --porcelain -- .projectrose/', { cwd: rootPath, encoding: 'utf-8' }).trim()
    if (status) {
      const label = new Date().toISOString().slice(0, 16).replace('T', ' ')
      execSync('git add .projectrose/', { cwd: rootPath, stdio: 'ignore' })
      execSync(`git commit -m "Heartbeat: update agent files [${label}]"`, { cwd: rootPath, stdio: 'ignore' })
    }
  } catch { /* git not available or not a repo */ }

  if (agentError) throw agentError
  return agentResult
}

// ─────────────────────────────────────────────────────────────────────────
// Logs
// ─────────────────────────────────────────────────────────────────────────

async function getLogFiles(rootPath: string): Promise<string[]> {
  const logsDir = prPath(rootPath, 'heartbeat', 'logs')
  try {
    const files = await readdir(logsDir)
    const mdFiles = files.filter((f) => f.endsWith('.md') && f !== '.gitkeep')
    const withStats = await Promise.all(
      mdFiles.map(async (f) => {
        const s = await stat(join(logsDir, f)).catch(() => null)
        return { name: f, mtime: s?.mtime ?? new Date(0) }
      })
    )
    return withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).map((x) => x.name)
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────

async function listTasks(rootPath: string): Promise<TaskMeta[]> {
  const tasksDir = prPath(rootPath, 'heartbeat', 'tasks')
  const files = await listMdFiles(tasksDir)
  const metas = await Promise.all(files.map((f) => readTaskMeta(tasksDir, f)))
  return metas
    .filter((m): m is TaskMeta => m !== null)
    .sort((a, b) => {
      const aDone = a.status === 'completed'
      const bDone = b.status === 'completed'
      if (aDone !== bDone) return aDone ? 1 : -1
      const ad = a.due ? new Date(a.due).getTime() : Infinity
      const bd = b.due ? new Date(b.due).getTime() : Infinity
      if (ad !== bd) return ad - bd
      return b.createdAt - a.createdAt
    })
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'task'
}

// Append -2/-3/... to the slug portion of `filename` until the resulting path
// doesn't already exist in tasksDir.
function uniqueFilenameInDir(tasksDir: string, filename: string, ignoreFilename: string | null = null): string {
  if (filename === ignoreFilename) return filename
  if (!existsSync(join(tasksDir, filename))) return filename
  const m = filename.match(/^(.+?)\.md$/)
  if (!m) return filename
  const base = m[1]
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}.md`
    if (candidate === ignoreFilename) return candidate
    if (!existsSync(join(tasksDir, candidate))) return candidate
  }
  // unreachable in practice
  return filename
}

interface CreateTaskInput {
  title: string
  description: string
  due: string | null            // ISO 8601 string or null for "next heartbeat"
  recurrence?: string | null    // e.g. "1d", "30m", or null/absent for one-time
  until?: string | null         // ISO 8601 string; recurring tasks only
  runs_left?: number | null     // positive integer; recurring tasks only
}

function buildTaskFile(opts: {
  title: string
  description: string
  due: string
  recurrence?: string | null
  until?: string | null
  runs_left?: number | null
  paused?: boolean
  status?: string
  preserveMemorySection?: string  // existing memory body to preserve verbatim
}): string {
  const isRecurring = !!parseRecurrence(opts.recurrence)
  const fmLines = [
    '---',
    `title: ${formatYamlValue(opts.title)}`,
    `due: ${opts.due}`,
    `status: ${opts.status ?? 'pending'}`,
  ]
  if (opts.recurrence) fmLines.push(`recurrence: ${opts.recurrence}`)
  if (opts.paused) fmLines.push('paused: true')
  if (opts.until) fmLines.push(`until: ${opts.until}`)
  if (typeof opts.runs_left === 'number' && opts.runs_left > 0) fmLines.push(`runs_left: ${opts.runs_left}`)
  fmLines.push('---', '')

  const lines: string[] = [...fmLines, `# ${opts.title}`, '']
  if (opts.description.trim()) lines.push(opts.description.trim(), '')

  if (isRecurring) {
    if (opts.preserveMemorySection !== undefined) {
      lines.push(opts.preserveMemorySection.trimEnd(), '')
    } else {
      lines.push(MEMORY_HEADING, '', MEMORY_PLACEHOLDER, '')
    }
  }

  return lines.join('\n')
}

async function createTask(rootPath: string, input: CreateTaskInput): Promise<TaskMeta> {
  const tasksDir = prPath(rootPath, 'heartbeat', 'tasks')
  await mkdir(tasksDir, { recursive: true }).catch(() => {})

  const title = input.title.trim() || 'Untitled task'
  const description = input.description.trim()
  const due = input.due ?? new Date().toISOString()

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const desiredName = `${stamp}-${slugify(title)}.md`
  const filename = uniqueFilenameInDir(tasksDir, desiredName)

  const content = buildTaskFile({
    title,
    description,
    due,
    recurrence: input.recurrence ?? null,
    until: input.until ?? null,
    runs_left: input.runs_left ?? null,
  })

  await writeFile(join(tasksDir, filename), content, 'utf-8')
  const meta = await readTaskMeta(tasksDir, filename)
  if (!meta) throw new Error('Failed to read newly created task')
  return meta
}

interface UpdateTaskPatch {
  title?: string
  description?: string
  due?: string
  recurrence?: string | null    // null clears recurrence (becomes one-time)
  paused?: boolean
  until?: string | null         // null clears
  runs_left?: number | null     // null clears
}

// Splits a task body into the prose-description portion and the memory portion.
// Memory portion is everything from the first `## Memory` heading to EOF (kept
// verbatim). Description is everything before that heading, with the leading
// `# Title` line stripped (we re-emit it from the new title).
function splitBody(body: string): { description: string; memorySection: string } {
  const memoryIdx = body.search(/^## Memory\b/m)
  const beforeMemory = memoryIdx === -1 ? body : body.slice(0, memoryIdx)
  const memorySection = memoryIdx === -1 ? '' : body.slice(memoryIdx)
  // strip leading `# Title` and surrounding whitespace from the description
  const description = beforeMemory.replace(/^\s*#\s+.*\n+/, '').trim()
  return { description, memorySection }
}

async function updateTask(
  rootPath: string,
  filename: string,
  patch: UpdateTaskPatch
): Promise<TaskMeta> {
  assertValidTaskFilename(filename)
  const tasksDir = prPath(rootPath, 'heartbeat', 'tasks')
  const oldPath = join(tasksDir, filename)
  const original = await readFile(oldPath, 'utf-8')

  const fm = parseFrontmatter(original)
  const body = bodyAfterFrontmatter(original)
  const split = splitBody(body)

  const oldTitle = (fm.title || '').trim() || filename.replace(/\.md$/, '')
  const newTitle = patch.title !== undefined ? (patch.title.trim() || 'Untitled task') : oldTitle
  const newDescription = patch.description !== undefined ? patch.description.trim() : split.description
  const newDue = patch.due !== undefined ? patch.due : (fm.due ?? new Date().toISOString())

  const newRecurrence = patch.recurrence !== undefined
    ? (patch.recurrence ?? null)
    : (fm.recurrence ?? null)
  const newUntil = patch.until !== undefined
    ? (patch.until ?? null)
    : (fm.until ?? null)
  let newRunsLeft: number | null
  if (patch.runs_left !== undefined) {
    newRunsLeft = patch.runs_left
  } else if (fm.runs_left !== undefined && /^-?\d+$/.test(fm.runs_left)) {
    newRunsLeft = parseInt(fm.runs_left, 10)
  } else {
    newRunsLeft = null
  }
  const newPaused = patch.paused !== undefined ? patch.paused : fm.paused === 'true'
  const newStatus = fm.status || 'pending'

  // Compute target filename: preserve original timestamp prefix, swap slug.
  // Filenames are <YYYY-MM-DDTHH-MM-SS-mmmZ>-<slug>.md (`:` and `.` from
  // toISOString() are replaced with `-` at create time).
  const stampMatch = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)-(.+)\.md$/)
  let desiredName = filename
  if (patch.title !== undefined && newTitle !== oldTitle) {
    if (stampMatch) {
      desiredName = `${stampMatch[1]}-${slugify(newTitle)}.md`
    } else {
      // Old file lacks the standard prefix; just slug the new title.
      desiredName = `${slugify(newTitle)}.md`
    }
  }
  const finalName = desiredName === filename
    ? filename
    : uniqueFilenameInDir(tasksDir, desiredName, filename)

  const isRecurring = !!parseRecurrence(newRecurrence)
  const preserveMemory = isRecurring ? (split.memorySection || undefined) : undefined

  const content = buildTaskFile({
    title: newTitle,
    description: newDescription,
    due: newDue,
    recurrence: newRecurrence,
    paused: newPaused,
    until: newUntil,
    runs_left: newRunsLeft,
    status: newStatus,
    preserveMemorySection: preserveMemory,
  })

  if (finalName === filename) {
    await writeFile(oldPath, content, 'utf-8')
  } else {
    const newPath = join(tasksDir, finalName)
    await writeFile(newPath, content, 'utf-8')
    await unlink(oldPath).catch(() => {})
  }

  const meta = await readTaskMeta(tasksDir, finalName)
  if (!meta) throw new Error('Failed to read updated task')
  return meta
}

async function deleteTask(rootPath: string, filename: string): Promise<void> {
  assertValidTaskFilename(filename)
  const tasksDir = prPath(rootPath, 'heartbeat', 'tasks')
  await unlink(join(tasksDir, filename)).catch(() => {})
}

async function getTaskContent(rootPath: string, filename: string): Promise<string> {
  assertValidTaskFilename(filename)
  const tasksDir = prPath(rootPath, 'heartbeat', 'tasks')
  return readFile(join(tasksDir, filename), 'utf-8')
}

// ─────────────────────────────────────────────────────────────────────────
// IPC registration
// ─────────────────────────────────────────────────────────────────────────

export function register(ctx: ExtCtx): () => void {
  const { rootPath } = ctx

  // Quiet "unused import" warning for `rename` — kept in import block in case
  // future filename moves switch back to atomic rename. Currently we use
  // writeFile + unlink for cross-volume safety on Windows.
  void rename

  // Tick state shared across the polling timer, manual-run handler, and the
  // status IPC. lastRun is the wall-clock time the most recent heartbeat
  // *started* (manual or scheduled); 0 means "never run this session".
  const INITIAL_DELAY_MS = 5_000
  const registeredAt = Date.now()
  let lastRun = 0

  ipcMain.handle('rose-heartbeat:run', async (_event, path: string) => {
    lastRun = Date.now()
    return runHeartbeat(path, ctx)
  })
  ipcMain.handle('rose-heartbeat:getLogs', (_event, path: string) => getLogFiles(path))
  ipcMain.handle('rose-heartbeat:logContent', async (_event, path: string, filename: string) =>
    readFile(prPath(path, 'heartbeat', 'logs', filename), 'utf-8')
  )
  ipcMain.handle('rose-heartbeat:listTasks', (_event, path: string) => listTasks(path))
  ipcMain.handle('rose-heartbeat:createTask', (_event, path: string, input: CreateTaskInput) =>
    createTask(path, input)
  )
  ipcMain.handle('rose-heartbeat:updateTask', (_event, path: string, filename: string, patch: UpdateTaskPatch) =>
    updateTask(path, filename, patch)
  )
  ipcMain.handle('rose-heartbeat:deleteTask', (_event, path: string, filename: string) =>
    deleteTask(path, filename)
  )
  ipcMain.handle('rose-heartbeat:taskContent', (_event, path: string, filename: string) =>
    getTaskContent(path, filename)
  )
  ipcMain.handle('rose-heartbeat:getStatus', async () => {
    const settings = await ctx.getSettings()
    const enabled = (settings.heartbeatEnabled as boolean) ?? true
    const intervalMinutes = (settings.heartbeatIntervalMinutes as number) ?? 5
    const intervalMs = intervalMinutes * 60_000
    const nextRun = !enabled
      ? null
      : lastRun > 0
        ? lastRun + intervalMs
        : registeredAt + INITIAL_DELAY_MS
    return {
      enabled,
      intervalMinutes,
      lastRun: lastRun > 0 ? lastRun : null,
      nextRun,
    }
  })

  // Polling timer: check every minute, skip if disabled or interval hasn't elapsed
  const timer = setInterval(async () => {
    try {
      const settings = await ctx.getSettings()
      const enabled = (settings.heartbeatEnabled as boolean) ?? true
      const intervalMs = ((settings.heartbeatIntervalMinutes as number) ?? 5) * 60 * 1000
      if (!enabled || Date.now() - lastRun < intervalMs) return
      lastRun = Date.now()
      await runHeartbeat(rootPath, ctx)
    } catch { /* ignore */ }
  }, 60_000)

  // Initial run shortly after project opens
  const initTimer = setTimeout(() => {
    ctx.getSettings().then(async (settings) => {
      if ((settings.heartbeatEnabled as boolean) ?? true) {
        lastRun = Date.now()
        await runHeartbeat(rootPath, ctx).catch(() => {})
      }
    }).catch(() => {})
  }, INITIAL_DELAY_MS)

  return () => {
    clearInterval(timer)
    clearTimeout(initTimer)
    ipcMain.removeHandler('rose-heartbeat:run')
    ipcMain.removeHandler('rose-heartbeat:getLogs')
    ipcMain.removeHandler('rose-heartbeat:logContent')
    ipcMain.removeHandler('rose-heartbeat:listTasks')
    ipcMain.removeHandler('rose-heartbeat:createTask')
    ipcMain.removeHandler('rose-heartbeat:updateTask')
    ipcMain.removeHandler('rose-heartbeat:deleteTask')
    ipcMain.removeHandler('rose-heartbeat:taskContent')
    ipcMain.removeHandler('rose-heartbeat:getStatus')
  }
}
