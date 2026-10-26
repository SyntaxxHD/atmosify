import type { Tools } from './config'
import { languageLabel, type Probe, type Track } from './probe'

export interface NewTrack {
  source: Track
  ec3: string
  channelLayout?: string
}

export function trackName(n: NewTrack): string {
  const layout = n.channelLayout?.replace(/\(.*\)$/, '')
  return [languageLabel(n.source), 'DD+ Atmos', layout].filter(Boolean).join(' ')
}

/**
 * The original file plus one .ec3 per converted track.
 * Each new track is placed directly before the TrueHD track it was made from, inherits
 * its language, and takes over its default flag.
 */
export function buildMuxCommand(
  probe: Probe,
  added: NewTrack[],
  opts: { tools: Tools; output: string; dropTrueHd: boolean }
): string[] {
  const cmd = [opts.tools.mkvmerge, '--output', opts.output]
  const sourceIds = new Set(added.map(a => a.source.id))

  if (opts.dropTrueHd) {
    cmd.push('--audio-tracks', `!${[...sourceIds].join(',')}`)
  }

  for (const a of added) {
    if (a.source.isDefault && !opts.dropTrueHd)
      cmd.push('--default-track-flag', `${a.source.id}:0`)
  }

  cmd.push(probe.path)

  added.forEach(a => {
    cmd.push('--language', `0:${a.source.languageIetf || a.source.language}`)
    cmd.push('--track-name', `0:${trackName(a)}`)
    cmd.push('--default-track-flag', `0:${a.source.isDefault ? 1 : 0}`)
    if (a.source.startMs !== 0) cmd.push('--sync', `0:${a.source.startMs}`)
    cmd.push(a.ec3)
  })

  const order: string[] = []
  for (const t of probe.tracks) {
    const idx = added.findIndex(a => a.source.id === t.id)

    if (idx >= 0) {
      order.push(`${idx + 1}:0`)
    }

    if (!(opts.dropTrueHd && sourceIds.has(t.id))) {
      order.push(`0:${t.id}`)
    }
  }

  cmd.push('--track-order', order.join(','))
  return cmd
}

export async function mux(cmd: string[]): Promise<void> {
  const proc = Bun.spawn([cmd[0]!, '--ui-language', 'en', ...cmd.slice(1)], {
    stdout: 'pipe',
    stderr: 'pipe'
  })

  const lines: string[] = []
  const decoder = new TextDecoder()
  for await (const chunk of proc.stdout) {
    for (const line of decoder.decode(chunk, { stream: true }).split(/\r?\n/)) {
      const pct = line.match(/Progress: (\d+)%/)

      if (pct) {
        process.stdout.write(`\r    ${pct[1]}%`)
      } else if (line.trim()) {
        lines.push(line)
      }
    }
  }

  process.stdout.write('\r')
  const code = await proc.exited

  // mkvmerge exits 1 for warnings (output still written) and 2 for errors.
  const problems = lines.filter(l => /^(Warning|Error)/.test(l))
  for (const p of problems) {
    console.log(`    ${p}`)
  }

  if (code >= 2) {
    throw new Error(
      `mkvmerge failed: ${problems.at(-1) ?? (await new Response(proc.stderr).text()).trim()}`
    )
  }
}
