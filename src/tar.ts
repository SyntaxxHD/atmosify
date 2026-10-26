// Minimal ustar reader/writer for the bundled build: regular files only.

import { chmod, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BunFile } from 'bun'

const BLOCK = 512
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface TarEntry {
  path: string
  source: string
  mode: number
}

function header(path: string, size: number, mode: number): Uint8Array {
  if (encoder.encode(path).length > 100) throw new Error(`Path too long for tar: ${path}`)

  const h = new Uint8Array(BLOCK)
  const put = (offset: number, value: string) => h.set(encoder.encode(value), offset)
  const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, '0')

  put(0, path)
  put(100, octal(mode, 8))
  put(108, octal(0, 8))
  put(116, octal(0, 8))
  put(124, octal(size, 12))
  put(136, octal(0, 12))
  put(148, ' '.repeat(8))
  put(156, '0')
  put(257, 'ustar\0')
  put(263, '00')

  const sum = h.reduce((a, b) => a + b, 0)
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `)

  return h
}

export async function packTar(entries: TarEntry[], out: string): Promise<void> {
  const writer = Bun.file(out).writer()

  for (const e of entries) {
    const file = Bun.file(e.source)
    writer.write(header(e.path, file.size, e.mode))

    for await (const chunk of file.stream()) {
      writer.write(chunk)
      await writer.flush()
    }

    const pad = (BLOCK - (file.size % BLOCK)) % BLOCK
    if (pad) writer.write(new Uint8Array(pad))
  }

  writer.write(new Uint8Array(BLOCK * 2))
  await writer.end()
}

export async function unpackTar(tar: BunFile, dest: string): Promise<void> {
  let offset = 0

  while (offset + BLOCK <= tar.size) {
    const h = new Uint8Array(await tar.slice(offset, offset + BLOCK).arrayBuffer())
    if (h.every(b => b === 0)) break

    const field = (start: number, length: number) =>
      decoder.decode(h.subarray(start, start + length)).replace(/\0[\s\S]*$/, '')

    const path = field(0, 100)
    const mode = parseInt(field(100, 8), 8)
    const size = parseInt(field(124, 12).trim(), 8)
    const type = field(156, 1)
    offset += BLOCK

    if (path.split('/').includes('..')) throw new Error(`Unsafe path in bundle: ${path}`)

    if (type === '0' || type === '') {
      const target = join(dest, path)
      await mkdir(dirname(target), { recursive: true })
      await Bun.write(target, tar.slice(offset, offset + size))

      if (process.platform !== 'win32' && mode & 0o111) await chmod(target, mode)
    }

    offset += Math.ceil(size / BLOCK) * BLOCK
  }
}
