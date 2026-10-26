import bundle from '../vendor/bundle.tar' with { type: 'file' }
import { extractBundle } from './embedded'
import { run } from './main'

process.exit(await run(() => extractBundle(bundle)))
