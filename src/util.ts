export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a command and capture its output. */
export async function run(cmd: string[]): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])

  return { code, stdout, stderr }
}

let current: Bun.Subprocess | undefined

/** Run a command with its output streamed straight to this terminal. */
export async function runLive(cmd: string[]): Promise<number> {
  current = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' })
  const code = await current.exited
  current = undefined

  return code
}

export function killCurrent(): void {
  current?.kill()
}

/**
 * True when this process is the only one attached to its console, this means it was started from
 * Explorer (drag & drop, double-click, Send To) and the window closes as soon as it exits.
 */
export function ownsConsole(): boolean {
  if (process.platform !== 'win32') return false

  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    const { symbols, close } = dlopen('kernel32.dll', {
      GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 }
    })

    const ids = new Uint32Array(4)
    const count = symbols.GetConsoleProcessList(ptr(ids), ids.length)

    close()

    return count === 1
  } catch {
    return false
  }
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Math.abs(n)

  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }

  return `${n < 0 ? '-' : ''}${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
