/**
 * Read-only preview: what would the host half add on THIS machine right now?
 *
 * Mounts the real plugin against the real shared registry file and the real
 * session projection cache, with a registry stub that only RECORDS creates —
 * nothing is written, no Host is contacted.
 *
 * Run: node tests/dry-run.mjs
 */

import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const registryFile = join(home, 'storages', 'workspace.json')
const projcacheDir = join(home, 'storages', 'session_projcache', 'sessions')

// The desktop's live registry, approximated by the shared file's own table.
const live = []
try {
  const parsed = JSON.parse(readFileSync(registryFile, 'utf8'))
  for (const entry of Object.values(parsed?.tables?.workspaces ?? {})) {
    if (typeof entry?.path === 'string') live.push(entry.path)
  }
} catch (error) {
  console.error('cannot read shared registry:', error.message)
}

// sessionQuery.listSessions() → record.header.cwd, approximated from the cache.
const sessionCwds = []
let cachedSessions = 0
try {
  for (const file of readdirSync(projcacheDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const record = JSON.parse(readFileSync(join(projcacheDir, file), 'utf8'))
      const cwd = record?.record?.identity?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) {
        cachedSessions += 1
        sessionCwds.push(cwd)
      }
    } catch {
      /* a single unreadable cache entry is not interesting here */
    }
  }
} catch {
  /* cache may not exist */
}

const created = []
let handle = null
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(key) {
    if (key === 'workspaceRegistry') {
      return {
        list: () => live.map((path) => ({ path })),
        // RECORD ONLY — the real host would persist and publish here.
        create: async (path) => { created.push(path); return { path } },
      }
    }
    if (key === 'sessionQuery') return { listSessions: async () => sessionCwds.map((cwd) => ({ header: { cwd } })) }
    if (key === 'connection') return { fetch: { register(route) { handle = route.fetch; return () => {} } } }
    return undefined
  },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') ctx._disposers.push(dispose) },
  _disposers: [],
}

console.log(`registry file : ${registryFile}`)
console.log(`live entries  : ${live.length}`)
console.log(`cached sessions with cwd: ${cachedSessions}`)
console.log('')

// Read-only preview: the registry is read from the real home, but every file this
// mounting could WRITE stays in a throwaway directory.
const scratch = mkdtempSync(join(tmpdir(), 'wsync-dry-'))
apply(ctx, { autoSync: false, inbox: { enabled: false }, stateFile: join(scratch, 'state.json'), registryFile, includeUngroupedSessions: true })
await new Promise((resolve) => setTimeout(resolve, 300))

const response = await handle(new Request('http://127.0.0.1/api/workspace-sync'))
const { data } = await response.json()
const run = data.lastRun

console.log(`candidates    : ${run.external} from registry, ${run.sessionOnly} from sessions`)
console.log(`already known : ${run.alreadyRegistered}`)
console.log('')
console.log(`WOULD ADD (${created.length}):`)
for (const path of created) console.log(`  + ${path}`)
if (run.skipped.length > 0) {
  console.log('')
  console.log(`skipped (${run.skipped.length}):`)
  for (const entry of run.skipped) console.log(`  - [${entry.why}] ${entry.path}`)
}
if (run.warnings.length > 0) {
  console.log('')
  console.log('warnings:')
  for (const warning of run.warnings) console.log(`  ! ${warning}`)
}

for (const dispose of ctx._disposers) dispose()
process.exit(0)
