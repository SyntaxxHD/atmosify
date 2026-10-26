import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tools } from './config'
import type { Track } from './probe'
import { runLive } from './util'

/** Encode one TrueHD Atmos track to DD+ Atmos (JOC) with DeeZy. Returns the .ec3 path. */
export async function encodeTrack(
  input: string,
  track: Track,
  opts: { tools: Tools; bitrate: number; tempDir: string }
): Promise<string> {
  const output = join(opts.tempDir, `track${track.id}.ec3`)
  const { ffmpeg, dee, truehdd } = opts.tools
  const toolArgs = [
    ...(ffmpeg ? ['--ffmpeg', ffmpeg] : []),
    ...(dee ? ['--dee', dee] : []),
    ...(truehdd ? ['--truehdd', truehdd] : [])
  ]

  const code = await runLive([
    opts.tools.deezy,
    'encode',
    'atmos',
    '--atmos-mode',
    'streaming',
    '--bitrate',
    String(opts.bitrate),
    '--track-index',
    `s:${track.id}`,
    '--temp-dir',
    opts.tempDir,
    '--output',
    output,
    '--overwrite',
    ...toolArgs,
    input
  ])

  if (code !== 0) throw new Error(`DeeZy failed on track ${track.id} (exit code ${code})`)
  if (!existsSync(output)) throw new Error(`DeeZy finished but did not write ${output}`)

  return output
}
