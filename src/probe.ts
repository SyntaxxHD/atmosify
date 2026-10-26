import type { Tools } from './config'
import { run } from './util'

export interface Track {
  id: number // mkvmerge track ID, which is also the ffmpeg stream index.
  type: 'video' | 'audio' | 'subtitles' | string
  codecId: string
  language: string
  languageIetf?: string
  name?: string
  isDefault: boolean
  channels?: number
  codecName?: string // ffprobe fields (audio only).
  profile?: string
  channelLayout?: string
  startMs: number
}

export interface Probe {
  path: string
  durationMs?: number
  tracks: Track[]
}

export const TRUEHD_ATMOS = 'Dolby TrueHD + Dolby Atmos'
export const DDP_ATMOS = 'Dolby Digital Plus + Dolby Atmos'

export const isTrueHdAtmos = (t: Track) =>
  t.type === 'audio' && t.codecName === 'truehd' && t.profile === TRUEHD_ATMOS
export const isDdpAtmos = (t: Track) =>
  t.type === 'audio' && t.codecName === 'eac3' && t.profile === DDP_ATMOS

/** Which ffmpeg codec name each Matroska codec ID must decode as. Used to check that both tools agree. */
const CODEC_MATCH: Record<string, string> = {
  A_TRUEHD: 'truehd',
  A_EAC3: 'eac3',
  A_AC3: 'ac3',
  A_DTS: 'dts',
  A_FLAC: 'flac',
  A_AAC: 'aac',
  A_OPUS: 'opus'
}

interface MkvmergeJson {
  container?: { recognized?: boolean; properties?: { duration?: number } }
  errors?: string[]
  tracks?: {
    id: number
    type: string
    properties: {
      codec_id?: string
      language?: string
      language_ietf?: string
      track_name?: string
      default_track?: boolean
      audio_channels?: number
    }
  }[]
}

interface FfprobeJson {
  format?: { duration?: string }
  streams?: {
    index: number
    codec_type: string
    codec_name?: string
    profile?: string
    channel_layout?: string
    start_time?: string
  }[]
}

export async function probe(path: string, tools: Tools): Promise<Probe> {
  const [mkv, ff] = await Promise.all([
    run([tools.mkvmerge, '-J', path]),
    run([
      tools.ffprobe,
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      path
    ])
  ])

  const m = JSON.parse(mkv.stdout || '{}') as MkvmergeJson
  if (!m.container?.recognized || !m.tracks) {
    throw new Error(
      `mkvmerge could not read the file${m.errors?.length ? `: ${m.errors.join('; ')}` : ''}`
    )
  }

  if (ff.code !== 0) {
    throw new Error(`ffprobe failed: ${ff.stderr.trim()}`)
  }

  const f = JSON.parse(ff.stdout) as FfprobeJson
  const streams = new Map((f.streams ?? []).map(s => [s.index, s]))

  const tracks = m.tracks.map((t): Track => {
    const s = streams.get(t.id)
    const p = t.properties
    const track: Track = {
      id: t.id,
      type: t.type,
      codecId: p.codec_id ?? '',
      language: p.language ?? 'und',
      languageIetf: p.language_ietf,
      name: p.track_name,
      isDefault: p.default_track ?? false,
      channels: p.audio_channels,
      startMs: 0
    }

    if (t.type === 'audio') {
      const expected = CODEC_MATCH[track.codecId]

      if (!s || s.codec_type !== 'audio' || (expected && s.codec_name !== expected)) {
        throw new Error(
          `mkvmerge and ffprobe disagree about track ${t.id} (${track.codecId} vs ${s?.codec_name ?? 'missing'}). Not touching this file...`
        )
      }

      track.codecName = s.codec_name
      track.profile = s.profile
      track.channelLayout = s.channel_layout
      track.startMs = Math.round(parseFloat(s.start_time ?? '0') * 1000) || 0
    }

    return track
  })

  const durationNs = m.container.properties?.duration
  const durationMs = durationNs
    ? durationNs / 1e6
    : f.format?.duration
      ? parseFloat(f.format.duration) * 1000
      : undefined

  return { path, durationMs, tracks }
}

/** Probe just an audio elementary stream (the .ec3 DeeZy wrote). */
export async function probeAudio(
  path: string,
  tools: Tools
): Promise<{ codecName?: string; profile?: string; channelLayout?: string }> {
  const r = await run([
    tools.ffprobe,
    '-v',
    'error',
    '-show_streams',
    '-select_streams',
    'a:0',
    '-of',
    'json',
    path
  ])
  const s = (JSON.parse(r.stdout || '{}') as FfprobeJson).streams?.[0]

  return {
    codecName: s?.codec_name,
    profile: s?.profile,
    channelLayout: s?.channel_layout
  }
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })
const ISO639_2: Record<string, string> = {
  eng: 'en',
  ger: 'de',
  deu: 'de',
  fre: 'fr',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  jpn: 'ja',
  por: 'pt',
  rus: 'ru',
  dut: 'nl',
  nld: 'nl',
  pol: 'pl',
  tur: 'tr',
  cze: 'cs',
  ces: 'cs',
  chi: 'zh',
  zho: 'zh',
  kor: 'ko',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  hun: 'hu',
  gre: 'el',
  ell: 'el'
}

/** Normalized language key so "ger", "deu" and "de-DE" compare equal. */
export function langKey(t: Track): string {
  const ietf = t.languageIetf?.split('-')[0]?.toLowerCase()
  if (ietf && ietf !== 'und') {
    return ietf
  }

  return ISO639_2[t.language] ?? t.language
}

export function languageLabel(t: Track): string {
  const code =
    t.languageIetf && t.languageIetf !== 'und'
      ? t.languageIetf
      : (ISO639_2[t.language] ?? t.language)
  if (!code || code === 'und') {
    return ''
  }

  try {
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}
