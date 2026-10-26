import { isDdpAtmos, isTrueHdAtmos, langKey, type Probe, type Track } from './probe'

export interface FilePlan {
  convert: Track[]
  skipped: { track: Track; reason: string }[]
}

export function planFile(p: Probe): FilePlan {
  const ddpLangs = new Set(p.tracks.filter(isDdpAtmos).map(langKey))
  const plan: FilePlan = { convert: [], skipped: [] }

  for (const t of p.tracks.filter(isTrueHdAtmos)) {
    if (ddpLangs.has(langKey(t))) {
      plan.skipped.push({
        track: t,
        reason: 'already has a DD+ Atmos track in this language'
      })
    } else {
      plan.convert.push(t)
    }
  }
  return plan
}
