/** Source-only Node --import hook; installed helpers remain synchronously importable. */
import { basename } from 'node:path'
import { preloadSourceInstance } from './instance-preload.mjs'

await preloadSourceInstance({ watcher: basename(process.argv[1] ?? '') === 'dev-web.ts' })
