// Downloads the third-party tools embedded in the bundled build and packs them into
// vendor/bundle.tar. Linux bundles must be built on Linux (AppImage extraction and ldd).
// Usage: bun scripts/fetch-vendor.ts [windows-x64 | linux-x64]

import { chmod, copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { packTar, type TarEntry } from '../src/tar'
import vendor from '../vendor.json'

type Target = 'windows-x64' | 'linux-x64'
type Tool = keyof typeof vendor

const target = (process.argv[2] ??
  (process.platform === 'win32' ? 'windows-x64' : 'linux-x64')) as Target
const windows = target === 'windows-x64'
const EXE = windows ? '.exe' : ''

const root = join(import.meta.dir, '..', 'vendor')
const work = join(root, 'work')
const stage = join(root, 'stage')

async function exec(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string>
): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])

  if (code !== 0) throw new Error(`${cmd.join(' ')} failed (${code}): ${err.trim()}`)
  return out
}

async function unpack(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })

  if (archive.endsWith('.AppImage')) {
    await chmod(archive, 0o755)
    await exec([archive, '--appimage-extract'], dest)
  } else if (process.platform === 'win32') {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    await exec([tar, '-xf', archive, '-C', dest])
  } else if (archive.endsWith('.zip')) {
    await exec(['unzip', '-o', '-q', archive, '-d', dest])
  } else {
    await exec(['tar', '-xf', archive, '-C', dest])
  }
}

async function findFile(dir: string, name: string): Promise<string> {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) return join(entry.parentPath, entry.name)
  }

  throw new Error(`${name} not found in ${dir}`)
}

async function put(source: string, dest: string, mode = 0o755): Promise<void> {
  const target = join(stage, dest)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  if (!windows) await chmod(target, mode)
}

/** Stage an ELF binary plus the shared libraries it loads from `libRoot`, found via ldd. */
async function putElf(binary: string, libRoot: string, dir: string): Promise<void> {
  const libDirs = new Set<string>()
  for (const entry of await readdir(libRoot, { recursive: true, withFileTypes: true })) {
    if (entry.name.includes('.so')) libDirs.add(entry.parentPath)
  }

  const ldd = await exec(['ldd', binary], undefined, {
    PATH: process.env.PATH ?? '',
    LD_LIBRARY_PATH: [...libDirs].join(':')
  })

  for (const line of ldd.split('\n')) {
    const match = line.match(/^\s*(\S+) => (\/\S+)/)
    if (match && match[2]!.startsWith(libRoot)) {
      // copyFile follows symlinks, so each library lands under its soname
      await put(match[2]!, `${dir}/lib/${match[1]}`, 0o644)
    }
  }

  const name = basename(binary)
  await put(binary, `${dir}/bin/${name}`)

  const wrapper = join(work, `${name}.sh`)
  await Bun.write(
    wrapper,
    `#!/bin/sh\nhere=$(dirname "$(readlink -f "$0")")\n` +
      `LD_LIBRARY_PATH="$here/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$here/bin/${name}" "$@"\n`
  )
  await put(wrapper, `${dir}/${name}`)
}

const manifest: Record<string, string> = {}

const stageTool: Record<Tool, (dir: string) => Promise<void>> = {
  async deezy(dir) {
    await put(await findFile(dir, `deezy${EXE}`), `deezy${EXE}`)
    manifest.deezy = `deezy${EXE}`
  },

  async truehdd(dir) {
    await put(await findFile(dir, `truehdd${EXE}`), `truehdd${EXE}`)
    manifest.truehdd = `truehdd${EXE}`
  },

  async ffmpeg(dir) {
    const bin = dirname(await findFile(dir, `ffmpeg${EXE}`))

    if (windows) {
      for (const name of await readdir(bin)) {
        if (name.endsWith('.dll') || name === 'ffmpeg.exe' || name === 'ffprobe.exe') {
          await put(join(bin, name), `ffmpeg/${name}`)
        }
      }
    } else {
      await putElf(join(bin, 'ffmpeg'), dir, 'ffmpeg')
      await putElf(join(bin, 'ffprobe'), dir, 'ffmpeg')
    }

    manifest.ffmpeg = `ffmpeg/ffmpeg${EXE}`
    manifest.ffprobe = `ffmpeg/ffprobe${EXE}`
  },

  async mkvtoolnix(dir) {
    if (windows) {
      await put(await findFile(dir, 'mkvmerge.exe'), 'mkvmerge.exe')
      manifest.mkvmerge = 'mkvmerge.exe'
    } else {
      await putElf(
        join(dir, 'squashfs-root', 'usr', 'bin', 'mkvmerge'),
        dir,
        'mkvtoolnix'
      )
      manifest.mkvmerge = 'mkvtoolnix/mkvmerge'
    }
  }
}

async function verify(): Promise<void> {
  const checks: [string, string][] = [
    ['ffmpeg', '-version'],
    ['ffprobe', '-version'],
    ['mkvmerge', '--version'],
    ['truehdd', '--version']
  ]

  // A minimal environment proves the staged binaries don't depend on libraries from the build machine
  const env: Record<string, string> = windows
    ? {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      }
    : { PATH: '/usr/bin:/bin' }

  for (const [tool, flag] of checks) {
    const out = await exec([join(stage, manifest[tool]!), flag], undefined, env)
    console.log(`  ok  ${out.split('\n')[0]}`)
  }
}

await rm(root, { recursive: true, force: true })
await mkdir(work, { recursive: true })

const licenses: string[] = []

for (const [name, info] of Object.entries(vendor) as [Tool, (typeof vendor)[Tool]][]) {
  const asset = info.assets[target]
  console.log(`${name} ${info.version} (${target})`)

  const res = await fetch(asset.url)
  if (!res.ok) throw new Error(`Download failed: ${asset.url} (${res.status})`)

  const data = await res.arrayBuffer()
  const hash = new Bun.CryptoHasher('sha256').update(data).digest('hex')
  if (hash !== asset.sha256) {
    throw new Error(
      `Checksum mismatch for ${asset.url}\n  expected ${asset.sha256}\n  got      ${hash}`
    )
  }

  const archive = join(work, asset.url.split('/').pop()!)
  const dir = join(work, name)
  await Bun.write(archive, data)
  await unpack(archive, dir)
  await stageTool[name](dir)

  const license = await fetch(info.license)
  if (!license.ok) throw new Error(`License download failed: ${info.license}`)

  let text = await license.text()
  if (name === 'ffmpeg') {
    // The build's own notice lists the libraries compiled into this FFmpeg
    text = `${await Bun.file(await findFile(dir, 'LICENSE.txt')).text()}\n\n${text}`
  }

  const sources =
    'sources' in info
      ? `\nSource: ${info.sources.map(s => s.url).join('\n        ')}`
      : ''
  licenses.push(
    `${'='.repeat(72)}\n${name} ${info.version}\n${asset.url}${sources}\n${'='.repeat(72)}\n\n${text}`
  )
}

await Bun.write(join(stage, 'bundle.json'), JSON.stringify(manifest, null, 2))
await verify()

const entries: TarEntry[] = []
for (const entry of await readdir(stage, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue

  const source = join(entry.parentPath, entry.name)
  const path = relative(stage, source).split('\\').join('/')
  const executable = !path.includes('/lib/') && path !== 'bundle.json'
  entries.push({ path, source, mode: executable ? 0o755 : 0o644 })
}

await packTar(entries, join(root, 'bundle.tar'))
await Bun.write(
  join(root, 'THIRD_PARTY_LICENSES.txt'),
  `The bundled build of atmosify includes the following third-party software.\n` +
    `The complete corresponding source code for FFmpeg and MKVToolNix is attached to each release.\n\n` +
    licenses.join('\n\n')
)

await rm(work, { recursive: true, force: true })
await rm(stage, { recursive: true, force: true })

const size = Bun.file(join(root, 'bundle.tar')).size
console.log(
  `Packed ${entries.length} files (${(size / 1024 / 1024).toFixed(1)} MB) into vendor/bundle.tar`
)
