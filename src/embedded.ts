import chalk from 'chalk'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { version } from '../package.json'
import type { Embedded } from './config'
import { unpackTar } from './tar'

function cacheDir(): string {
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'))

  return join(base, 'atmosify', version)
}

/** Unpack the tools embedded in the bundled build, once per version. */
export async function extractBundle(bundlePath: string): Promise<Embedded> {
  const dir = cacheDir()
  const bundle = Bun.file(bundlePath)
  const marker = join(dir, '.complete')

  const current =
    existsSync(marker) && (await Bun.file(marker).text()) === String(bundle.size)
  if (!current) {
    console.log(chalk.dim(`Unpacking bundled tools to ${dir} (first run only)...`))

    // Unpack next to the target first so an interrupted run never leaves a half-written folder
    const partial = `${dir}.partial-${process.pid}`
    await rm(partial, { recursive: true, force: true })
    await mkdir(partial, { recursive: true })
    await unpackTar(bundle, partial)
    await Bun.write(join(partial, '.complete'), String(bundle.size))

    await rm(dir, { recursive: true, force: true })
    await rename(partial, dir)
  }

  const manifest = (await Bun.file(join(dir, 'bundle.json')).json()) as Embedded
  const tools = { ...manifest }

  for (const tool of Object.keys(tools) as (keyof Embedded)[]) {
    tools[tool] = join(dir, manifest[tool])
  }

  return tools
}
