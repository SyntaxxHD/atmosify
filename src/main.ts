import chalk from 'chalk'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { version } from '../package.json'
import { findDee, loadConfig, resolveTools, type Embedded, type Tools } from './config'
import { encodeTrack } from './encode'
import { buildMuxCommand, mux, trackName, type NewTrack } from './mux'
import { languageLabel, DDP_ATMOS, probe, probeAudio, type Track } from './probe'
import { planFile } from './plan'
import { formatBytes, killCurrent, ownsConsole } from './util'
import { verifyOutput } from './verify'

const USAGE = `${chalk.bold('atmosify')} ${version} - convert TrueHD Atmos tracks in MKV files to DD+ Atmos

Usage: atmosify <file.mkv | folder>... [options]

  --dry-run        Show what would be converted, change nothing
  --replace        Replace the original MKV after the result is verified
  --drop-truehd    Remove the converted TrueHD tracks from the output
  --bitrate <n>    DD+ Atmos bitrate in kbps (default from atmosify.toml, 768)
  --pause          Wait for Enter before closing (automatic for drag & drop / Send To)
  -v, --version    Show the version
  -h, --help       Show this help`

interface Result {
  file: string
  status: 'converted' | 'skipped' | 'failed' | 'dry-run'
  detail: string
  output?: string
  sizeDelta?: number
}

const TMP_MARK = '.atmosify-tmp'
let aborted = false

async function collectFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = []

  for (const raw of inputs) {
    const p = resolve(raw)

    if (!existsSync(p)) {
      console.log(chalk.yellow(`Not found, ignoring: ${p}`))
      continue
    }

    if (statSync(p).isDirectory()) {
      for await (const f of new Bun.Glob('**/*.mkv').scan({ cwd: p, absolute: true })) {
        if (!f.includes(TMP_MARK)) files.push(f)
      }
    } else if (extname(p).toLowerCase() === '.mkv') {
      files.push(p)
    } else {
      console.log(chalk.yellow(`Not an MKV, ignoring: ${p}`))
    }
  }

  return [...new Set(files)].sort()
}

function describe(t: Track): string {
  const lang = languageLabel(t) || 'unknown language'
  return `track ${t.id} (${lang}${t.name ? `, "${t.name}"` : ''}${t.isDefault ? ', default' : ''})`
}

async function processFile(
  file: string,
  opts: {
    tools: Tools
    bitrate: number
    replace: boolean
    dropTrueHd: boolean
    dryRun: boolean
    suffix: string
    tempRoot: string
  }
): Promise<Result> {
  const name = basename(file)
  const dir = dirname(file)
  const stem = basename(file, extname(file))

  const info = await probe(file, opts.tools)
  const plan = planFile(info)

  for (const s of plan.skipped) {
    console.log(chalk.dim(`  skip ${describe(s.track)}: ${s.reason}`))
  }

  if (plan.convert.length === 0) {
    const reason = plan.skipped.length
      ? 'DD+ Atmos already present'
      : 'no TrueHD Atmos track'
    console.log(chalk.dim(`  nothing to do (${reason})`))
    return { file: name, status: 'skipped', detail: reason }
  }

  const output = opts.replace
    ? join(dir, `${stem}${TMP_MARK}.mkv`)
    : join(dir, `${stem}${opts.suffix}.mkv`)
  if (!opts.replace && existsSync(output)) {
    console.log(chalk.dim(`  output already exists: ${basename(output)}`))
    return { file: name, status: 'skipped', detail: 'output already exists' }
  }

  for (const t of plan.convert) console.log(`  convert ${describe(t)}`)
  if (opts.dryRun) {
    const where = opts.replace ? 'replace original' : basename(output)
    return {
      file: name,
      status: 'dry-run',
      detail: `${plan.convert.length} track(s) -> ${where}`
    }
  }

  const tempDir = opts.tempRoot ? join(opts.tempRoot, stem) : join(dir, TMP_MARK, stem)
  await mkdir(tempDir, { recursive: true })
  let done = false

  try {
    const added: NewTrack[] = []
    for (const [i, t] of plan.convert.entries()) {
      console.log(
        chalk.cyan(
          `\n  [${i + 1}/${plan.convert.length}] encoding ${describe(t)} at ${opts.bitrate} kbps`
        )
      )

      const ec3 = await encodeTrack(file, t, {
        tools: opts.tools,
        bitrate: opts.bitrate,
        tempDir
      })
      const a = await probeAudio(ec3, opts.tools)

      if (a.codecName !== 'eac3' || a.profile !== DDP_ATMOS) {
        throw new Error(
          `DeeZy output for track ${t.id} is not DD+ Atmos (${a.codecName ?? '?'} / ${a.profile ?? 'no profile'})`
        )
      }

      added.push({ source: t, ec3, channelLayout: a.channelLayout })
    }

    console.log(chalk.cyan(`\n  muxing -> ${basename(output)}`))

    for (const a of added) {
      console.log(
        chalk.dim(`    + "${trackName(a)}"${a.source.isDefault ? ' (default)' : ''}`)
      )
    }

    await mux(
      buildMuxCommand(info, added, {
        tools: opts.tools,
        output,
        dropTrueHd: opts.dropTrueHd
      })
    )
    await verifyOutput(info, output, {
      tools: opts.tools,
      added: added.length,
      dropped: opts.dropTrueHd ? added.length : 0
    })

    const before = statSync(file).size
    const after = statSync(output).size
    let finalPath = output

    if (opts.replace) {
      const backup = `${file}.bak`
      await rename(file, backup)
      try {
        await rename(output, file)
      } catch (e) {
        await rename(backup, file)
        throw e
      }

      await rm(backup)
      finalPath = file
    }

    done = true
    const what = `${added.length} DD+ Atmos track(s) added${opts.dropTrueHd ? ', TrueHD removed' : ''}`
    console.log(chalk.green(`  done: ${what}`))

    return {
      file: name,
      status: 'converted',
      detail: what,
      output: finalPath,
      sizeDelta: after - before
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })

    if (!opts.tempRoot) await rmdir(join(dir, TMP_MARK)).catch(() => {})
    if (!done) await rm(output, { force: true })
  }
}

function printSummary(results: Result[]): void {
  if (results.length === 0) return

  console.log(chalk.bold('\nSummary'))
  const color = {
    converted: chalk.green,
    skipped: chalk.dim,
    failed: chalk.red,
    'dry-run': chalk.cyan
  }
  const width = Math.min(60, Math.max(...results.map(r => r.file.length)))

  for (const r of results) {
    const file =
      r.file.length > width ? `${r.file.slice(0, width - 1)}…` : r.file.padEnd(width)
    const size =
      r.sizeDelta !== undefined
        ? chalk.dim(` (${r.sizeDelta >= 0 ? '+' : ''}${formatBytes(r.sizeDelta)})`)
        : ''
    console.log(`  ${file}  ${color[r.status](r.status.padEnd(9))}  ${r.detail}${size}`)
  }
}

async function waitForEnter(): Promise<void> {
  process.stdout.write('\nPress Enter to close...')
  for await (const _ of console) break
}

/** The CLI. The bundled build passes `getEmbedded` to extract its built-in DeeZy and truehdd. */
export async function run(getEmbedded?: () => Promise<Embedded>): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      replace: { type: 'boolean' },
      'drop-truehd': { type: 'boolean' },
      bitrate: { type: 'string' },
      pause: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' }
    }
  })

  if (values.version) {
    console.log(version)
    return 0
  }

  const pause = !!values.pause || ownsConsole()
  try {
    const { config, path: configPath, created } = await loadConfig(!!getEmbedded)

    if (values.help || positionals.length === 0) {
      console.log(USAGE)
      console.log(
        created
          ? `\nCreated ${chalk.bold(configPath)}\nSet the path to dee under [tools] before converting.`
          : `\nConfig: ${configPath}`
      )

      return positionals.length === 0 && !values.help ? 1 : 0
    }

    if (created) {
      console.log(chalk.dim(`Created default config: ${configPath}`))
    }

    const tools = resolveTools(config, await getEmbedded?.())
    const bitrate = values.bitrate ? Number(values.bitrate) : config.bitrate

    if (!Number.isFinite(bitrate) || bitrate <= 0) {
      throw new Error(`Invalid bitrate: ${values.bitrate}`)
    }

    const opts = {
      tools,
      bitrate,
      replace: values.replace ?? config.replace_original,
      dropTrueHd: values['drop-truehd'] ?? config.drop_truehd,
      dryRun: !!values['dry-run'],
      suffix: config.output_suffix,
      tempRoot: config.temp_dir
    }

    const files = await collectFiles(positionals)
    if (files.length === 0) {
      console.log('No MKV files found.')
      return 1
    }

    // Fail before any work if DeeZy would not find DEE halfway through the first encode
    if (!opts.dryRun) {
      if (config.tools.dee && !existsSync(config.tools.dee)) {
        throw new Error(`dee not found at ${config.tools.dee} (set in ${configPath})`)
      }

      const dee = await findDee(tools)
      if (!dee) {
        throw new Error(
          `Dolby Encoding Engine not found. Set the path to dee.exe under [tools] in ${configPath}`
        )
      }

      tools.dee = dee
    }

    process.on('SIGINT', () => {
      aborted = true
      killCurrent()
    })

    const results: Result[] = []
    for (const [i, file] of files.entries()) {
      if (aborted) break
      console.log(chalk.bold(`\n[${i + 1}/${files.length}] ${basename(file)}`))

      try {
        results.push(await processFile(file, opts))
      } catch (e) {
        const msg = aborted ? 'cancelled' : (e as Error).message
        console.log(chalk.red(`  failed: ${msg}`))

        results.push({ file: basename(file), status: 'failed', detail: msg })
      }
    }

    printSummary(results)

    if (aborted) {
      console.log(chalk.yellow('\nCancelled.'))
    }

    return results.some(r => r.status === 'failed') || aborted ? 1 : 0
  } catch (e) {
    console.error(chalk.red(`Error: ${(e as Error).message}`))
    return 1
  } finally {
    if (pause) {
      await waitForEnter()
    }
  }
}
