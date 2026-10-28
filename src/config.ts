import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { run } from './util'

export interface Config {
  bitrate: number
  replace_original: boolean
  drop_truehd: boolean
  output_suffix: string
  temp_dir: string
  tools: {
    deezy: string
    mkvmerge: string
    ffprobe: string
    ffmpeg: string
    dee: string
    truehdd: string
  }
}

const EXE = process.platform === 'win32' ? '.exe' : ''

const DEFAULTS: Config = {
  bitrate: 768,
  replace_original: false,
  drop_truehd: false,
  output_suffix: '.atmos',
  temp_dir: '',
  tools: { deezy: '', mkvmerge: '', ffprobe: '', ffmpeg: '', dee: '', truehdd: '' }
}

const TEMPLATE = `# Atmosify configuration. Command-line flags override these values.

# DD+ Atmos bitrate in kbps (DeeZy picks the nearest allowed value).
bitrate = 768

# true: after the new MKV is verified, it replaces the original file.
# false: the result is written next to the original as "<name>${DEFAULTS.output_suffix}.mkv".
replace_original = false

# true: remove the TrueHD tracks that were converted, keeping only the new DD+ Atmos tracks.
drop_truehd = false

# Suffix for the new file when replace_original = false.
output_suffix = "${DEFAULTS.output_suffix}"

# Folder for temporary files. Empty = ".atmosify-tmp" next to each input file.
# TrueHD Atmos decoding needs several GB per track, so keep this on a roomy drive.
temp_dir = ""

[tools]
`

const TOOLS_BUNDLED = `# Dolby Encoding Engine: full path to dee.exe
dee = ""
`

const TOOLS_STANDARD = `# Full paths to the tools. Empty = find automatically (e.g. on PATH).
dee = ""       # Dolby Encoding Engine (dee.exe)
deezy = ""
mkvmerge = ""
ffmpeg = ""
ffprobe = ""
truehdd = ""
`

export function appDir(): string {
  const exe = process.execPath
  return basename(exe).toLowerCase().startsWith('bun')
    ? resolve(import.meta.dir, '..')
    : dirname(exe)
}

/** The bundled build only lists `dee` in a new config, since it ships every other tool. */
export async function loadConfig(bundled: boolean): Promise<{
  config: Config
  path: string
  created: boolean
}> {
  const path = join(appDir(), 'atmosify.toml')
  let created = false

  if (!existsSync(path)) {
    await Bun.write(path, TEMPLATE + (bundled ? TOOLS_BUNDLED : TOOLS_STANDARD))
    created = true
  }

  const parsed = Bun.TOML.parse(await Bun.file(path).text()) as Partial<Config>
  const config: Config = {
    ...DEFAULTS,
    ...parsed,
    tools: { ...DEFAULTS.tools, ...(parsed.tools ?? {}) }
  }

  return { config, path, created }
}

export interface Tools {
  deezy: string
  mkvmerge: string
  ffprobe: string
  // Optional overrides handed to DeeZy
  ffmpeg?: string
  dee?: string
  truehdd?: string
}

/** Binaries embedded in the bundled build, already extracted to disk. */
export interface Embedded {
  deezy: string
  truehdd: string
  ffmpeg: string
  ffprobe: string
  mkvmerge: string
}

function firstExisting(candidates: (string | null | undefined)[]): string | undefined {
  return candidates.find((p): p is string => !!p && existsSync(p))
}

export function resolveTools(config: Config, embedded?: Embedded): Tools {
  const dir = appDir()
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'

  const deezy = firstExisting([
    config.tools.deezy,
    embedded?.deezy,
    join(dir, `deezy${EXE}`),
    Bun.which('deezy')
  ])

  const mkvmerge = firstExisting([
    config.tools.mkvmerge,
    embedded?.mkvmerge,
    Bun.which('mkvmerge'),
    EXE && join(programFiles, 'MKVToolNix', 'mkvmerge.exe')
  ])

  const ffprobe = firstExisting([
    config.tools.ffprobe,
    embedded?.ffprobe,
    join(dir, 'apps', 'ffmpeg', `ffprobe${EXE}`),
    Bun.which('ffprobe')
  ])

  const missing = Object.entries({ deezy, mkvmerge, ffprobe })
    .filter(([, v]) => !v)
    .map(([k]) => k)

  if (missing.length) {
    throw new Error(
      `Could not find: ${missing.join(', ')}. Set the path(s) under [tools] in atmosify.toml.`
    )
  }

  return {
    deezy: deezy!,
    mkvmerge: mkvmerge!,
    ffprobe: ffprobe!,
    ffmpeg: config.tools.ffmpeg || embedded?.ffmpeg,
    dee: config.tools.dee || undefined,
    truehdd: config.tools.truehdd || embedded?.truehdd
  }
}

/**
 * Find the Dolby Encoding Engine the way DeeZy would.
 */
export async function findDee(tools: Tools): Promise<string | undefined> {
  const direct = firstExisting([
    tools.dee,
    Bun.which('dee'),
    join(dirname(tools.deezy), 'apps', 'dee', `dee${EXE}`)
  ])

  if (direct) {
    return direct
  }

  const info = await run([tools.deezy, 'config', 'info'])
  const deezyConfig = info.stdout.match(/Active config file: (.+)/)?.[1]?.trim()

  if (!deezyConfig || !existsSync(deezyConfig)) {
    return undefined
  }

  const parsed = Bun.TOML.parse(await Bun.file(deezyConfig).text()) as {
    dependencies?: { dee?: string }
  }

  return firstExisting([parsed.dependencies?.dee])
}
