import { ipcMain } from 'electron'
import { join } from 'path'
import { readdir, readFile, writeFile, stat } from 'fs/promises'
import { execSync } from 'child_process'

interface ExtCtx {
  rootPath: string
  getSettings: () => Promise<Record<string, unknown>>
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
  broadcast: (channel: string, data: unknown) => void
  registerTools: (tools: unknown[]) => void
  runBackgroundAgent: (prompt: string) => Promise<string>
}

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

async function filterDueTasks(files: string[], tasksDir: string): Promise<string[]> {
  const now = new Date()
  const due: string[] = []
  for (const file of files) {
    try {
      const content = await readFile(join(tasksDir, file), 'utf-8')
      const match = content.match(/^---[\s\S]*?due:\s*(.+?)[\s\S]*?---/m)
      if (match) {
        const dueDate = new Date(match[1].trim())
        if (!isNaN(dueDate.getTime()) && dueDate <= now) due.push(file)
      }
    } catch { /* skip unreadable files */ }
  }
  return due
}

function buildPrompt(rootPath: string, dueTasks: string[]): string {
  const parts = [
    `You are processing the deferred work queue for the project at: ${rootPath}`,
    '',
    'Your job:'
  ]
  if (dueTasks.length > 0) {
    parts.push(
      '',
      `## Execute Due Tasks (${dueTasks.length} tasks in .projectrose/heartbeat/tasks/)`,
      ...dueTasks.map((t) => `- ${t}`),
      '',
      'For each due task: read the file, execute the described task using available tools,',
      'then update the status field in the YAML frontmatter to "completed".'
    )
  }
  parts.push('', 'Report concisely what you did for each item.')
  return parts.join('\n')
}

async function runHeartbeat(rootPath: string, ctx: ExtCtx): Promise<string> {
  const tasksDir = prPath(rootPath, 'heartbeat', 'tasks')
  const logsDir = prPath(rootPath, 'heartbeat', 'logs')
  const allTasks = await listMdFiles(tasksDir)
  const dueTasks = await filterDueTasks(allTasks, tasksDir)

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = join(logsDir, `${timestamp}.md`)

  if (dueTasks.length === 0) {
    await writeFile(logPath, `# Heartbeat — ${new Date().toLocaleString()}\n\nNothing to process.\n`, 'utf-8').catch(() => {})
    return 'Nothing to process.'
  }

  const content = await ctx.runBackgroundAgent(buildPrompt(rootPath, dueTasks))
  await writeFile(logPath, `# Heartbeat — ${new Date().toLocaleString()}\n\n${content}\n`, 'utf-8').catch(() => {})

  try {
    const status = execSync('git status --porcelain -- .projectrose/', { cwd: rootPath, encoding: 'utf-8' }).trim()
    if (status) {
      const label = new Date().toISOString().slice(0, 16).replace('T', ' ')
      execSync('git add .projectrose/', { cwd: rootPath, stdio: 'ignore' })
      execSync(`git commit -m "Heartbeat: update agent files [${label}]"`, { cwd: rootPath, stdio: 'ignore' })
    }
  } catch { /* git not available or not a repo */ }

  return content
}

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

export function register(ctx: ExtCtx): () => void {
  const { rootPath } = ctx

  ipcMain.handle('rose-heartbeat:run', (_event, path: string) => runHeartbeat(path, ctx))
  ipcMain.handle('rose-heartbeat:getLogs', (_event, path: string) => getLogFiles(path))
  ipcMain.handle('rose-heartbeat:logContent', async (_event, path: string, filename: string) =>
    readFile(prPath(path, 'heartbeat', 'logs', filename), 'utf-8')
  )

  // Polling timer: check every minute, skip if disabled or interval hasn't elapsed
  let lastRun = 0
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
  }, 5000)

  return () => {
    clearInterval(timer)
    clearTimeout(initTimer)
    ipcMain.removeHandler('rose-heartbeat:run')
    ipcMain.removeHandler('rose-heartbeat:getLogs')
    ipcMain.removeHandler('rose-heartbeat:logContent')
  }
}
