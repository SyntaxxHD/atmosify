import type { Tools } from './config'
import { isDdpAtmos, probe, type Probe } from './probe'

/** Check the muxed file before anything is replaced. Throws on the first problem. */
export async function verifyOutput(
  original: Probe,
  outputPath: string,
  opts: { tools: Tools; added: number; dropped: number }
): Promise<Probe> {
  const out = await probe(outputPath, opts.tools)

  const expectedTracks = original.tracks.length + opts.added - opts.dropped
  if (out.tracks.length !== expectedTracks) {
    throw new Error(
      `verification: expected ${expectedTracks} tracks, found ${out.tracks.length}`
    )
  }

  const expectedDdp = original.tracks.filter(isDdpAtmos).length + opts.added
  const ddp = out.tracks.filter(isDdpAtmos).length
  if (ddp !== expectedDdp) {
    throw new Error(
      `verification: expected ${expectedDdp} DD+ Atmos track(s), found ${ddp}`
    )
  }

  if (
    original.durationMs &&
    out.durationMs &&
    Math.abs(original.durationMs - out.durationMs) > 1000
  ) {
    throw new Error(
      `verification: duration changed from ${(original.durationMs / 1000).toFixed(1)}s to ${(out.durationMs / 1000).toFixed(1)}s`
    )
  }

  return out
}
