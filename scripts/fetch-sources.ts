// Downloads the corresponding source code of the GPL/LGPL tools in the bundled build
// into sources/, so each release can ship it next to the binaries.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import vendor from '../vendor.json'

const out = join(import.meta.dir, '..', 'sources')
await mkdir(out, { recursive: true })

for (const info of Object.values(vendor)) {
  if (!('sources' in info)) continue

  for (const source of info.sources) {
    console.log(source.name)
    const res = await fetch(source.url)
    if (!res.ok) throw new Error(`Download failed: ${source.url} (${res.status})`)

    await Bun.write(join(out, source.name), res)
  }
}
