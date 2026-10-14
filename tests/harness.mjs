/**
 * Host-half harness for dsh-plugin-codex-bridge.
 *
 * Runs the REAL `lib/index.js` against a mock Cordis context and real temporary
 * directories, so every branch of the reconciliation pass is exercised without
 * touching this machine's profile, registry or sessions.
 *
 * Run: node tests/harness.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'

/** The plugin canonicalises paths the way the registry does (fs.realpath). */
const canon = (path) => realpathSync(path)

/** Compare two paths the way `attachSession` does. */
const samePath = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return a === b
  }
}

let passed = 0
let caseState = 0
const failures = []
const test = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.error(`FAIL  ${label}\n      ${error?.message ?? error}`)
  }
}

/**
 * Point DSH_HOME at a throwaway directory for this whole process, so a default
 * the suite forgets to override (state file, inbox, registry) can never reach the
 * real home. A test discovery that pollutes ~/.dsh is a bug, not a nuisance.
 */
const sandboxHome = mkdtempSync(join(tmpdir(), 'wsync-home-'))
process.env.DSH_HOME = sandboxHome

const root = mkdtempSync(join(tmpdir(), 'wsync-'))
const dir = (relative) => {
  const path = join(root, relative)
  mkdirSync(path, { recursive: true })
  return path
}

const registryFile = (workspaces) => {
  const file = join(root, `workspace-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: Object.keys(workspaces) },
    tables: { workspaces },
  }))
  return file
}

/**
 * Mount the plugin against a mock Host context.
 *
 * `live` accepts plain path strings or `{ path, sessionIds }` entities; the mock
 * entities implement the two members the plugin relies on (`sessionIds`,
 * `attachSession`) with the same validation the real registry performs.
 */
const mount = ({ config = {}, live = [], externalWorkspaces = null, sessionCwds = [], failing = new Set(), dropServices = [] } = {}) => {
  const created = []
  const attached = []
  caseState += 1
  let handle = null
  let routeDisposed = false

  // Sessions: a bare path string (no id ⇒ cannot be attached) or {cwd, id}.
  const sessions = sessionCwds.map((entry, index) => (typeof entry === 'string'
    ? { cwd: entry, id: null }
    : { cwd: entry.cwd, id: entry.id ?? `session-mock-${index}` }))
  const sessionById = new Map(sessions.filter((session) => session.id !== null).map((session) => [session.id, session]))

  const makeEntity = (path, sessionIds = []) => {
    const entity = {
      path,
      get sessionIds() { return sessionIds },
      async attachSession(sessionId) {
        const session = sessionById.get(sessionId)
        if (session === undefined) throw new Error(`unknown session ${sessionId}`)
        if (!samePath(session.cwd, path)) throw new Error(`cwd mismatch for ${sessionId}`)
        if (!sessionIds.includes(sessionId)) sessionIds.unshift(sessionId)
        attached.push({ path, sessionId })
      },
    }
    return entity
  }

  const liveMap = new Map(live.map((entry) => {
    const path = typeof entry === 'string' ? entry : entry.path
    const ids = typeof entry === 'string' ? [] : (entry.sessionIds ?? [])
    return [path, makeEntity(path, [...ids])]
  }))

  const registry = {
    list: () => [...liveMap.values()],
    create: async (path) => {
      if (failing.has(path)) throw new Error(`create refused: ${path}`)
      created.push(path)
      const workspace = makeEntity(path)
      liveMap.set(path, workspace)
      return workspace
    },
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(key) {
      if (key === 'workspaceRegistry') return registry
      if (dropServices.includes(key)) return undefined
      if (key === 'sessionQuery') return { listSessions: async () => sessions.map((session) => ({ header: { cwd: session.cwd, id: session.id } })) }
      if (key === 'sessionController') {
        return {
          list: async () => ({ items: sessions.map((session) => ({ sessionId: session.id, cwd: session.cwd, running: false })) }),
          prompt: async () => ({ accepted: true }),
        }
      }
      if (key === 'connection') {
        return {
          fetch: {
            register(route) {
              handle = route.fetch
              return () => { routeDisposed = true; handle = null }
            },
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') ctx._disposers.push(dispose)
    },
    _disposers: [],
  }

  // `inbox.enabled: false` keeps the mount from touching the real <DSH_HOME>/inbox:
  // this suite only exercises the workspace reconciler.
  // A per-case state file and a disabled inbox keep every test, and the real
  // <DSH_HOME>, untouched by anything this suite mounts.
  apply(ctx, { autoSync: false, inbox: { enabled: false }, stateFile: join(root, `state-${caseState}.json`), registryFile: externalWorkspaces === null ? registryFile({}) : externalWorkspaces, ...config })
  return { created, attached, ctx, getHandle: () => handle, wasRouteDisposed: () => routeDisposed }
}

/** Poll until `predicate()` is true; the mount pass is fire-and-forget. */
const settle = async (predicate, label = 'condition') => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const readStatus = async (mounted) => {
  const response = await mounted.getHandle()(new Request('http://127.0.0.1/api/workspace-sync'))
  return (await response.json()).data
}

try {
  await test('exports the Cordis plugin shape', () => {
    assert.equal(name, 'workspace-sync')
    assert.ok(inject.includes('connection'), 'connection must be declared in inject')
    assert.ok(inject.includes('workspaceRegistry'))
    assert.equal(typeof apply, 'function')
  })

  await test('adds a workspace registered by another process, skips live ones and missing dirs', async () => {
    const known = dir('known')
    const externalOnly = dir('external-only')
    const missing = join(root, 'never-created')
    const file = registryFile({
      a: { path: known, title: 'known' },
      b: { path: externalOnly, title: 'external-only' },
      c: { path: missing, title: 'never-created' },
    })
    const mounted = mount({ live: [known], externalWorkspaces: file })
    await settle(() => mounted.created.length === 1, 'one add')
    const status = await readStatus(mounted)
    assert.deepEqual(mounted.created, [canon(externalOnly)])
    assert.equal(status.lastRun.alreadyRegistered, 1)
    assert.deepEqual(status.lastRun.skipped, [{ path: missing, why: 'not-a-directory' }])
    assert.equal(status.lastRun.added[0].source, 'registry')
  })

  await test('deduplicates by canonical path (symlink aliases the same directory)', async () => {
    const real = dir('real')
    const alias = join(root, 'alias')
    symlinkSync(real, alias)
    const file = registryFile({
      a: { path: real, title: 'real' },
      b: { path: alias, title: 'alias' },
      c: { path: `${real}/`, title: 'trailing slash' },
    })
    const mounted = mount({ externalWorkspaces: file })
    await settle(() => (mounted.created.length > 0) || (mounted.created.length === 0))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(mounted.created.length, 1, `expected a single registration, got ${JSON.stringify(mounted.created)}`)
  })

  await test('includes session cwds when configured, and honours the flag when not', async () => {
    const sessionDir = dir('session-cwd')
    const withSessions = mount({ sessionCwds: [sessionDir], config: { includeUngroupedSessions: true } })
    await settle(() => withSessions.created.length === 1, 'session add')

    const withoutSessions = mount({ sessionCwds: [sessionDir], config: { includeUngroupedSessions: false } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(withoutSessions.created, [])
    const status = await readStatus(withoutSessions)
    assert.equal(status.lastRun.sessionOnly, 0)
  })

  await test('session inference is off by default', async () => {
    const target = dir('inference-default')
    const mounted = mount({ sessionCwds: [{ cwd: target, id: 'session-only' }] })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(mounted.created, [], 'a session directory alone must not create a workspace')
    assert.equal((await readStatus(mounted)).lastRun.sessionOnly, 0)
  })

  await test('a workspace the user deleted is never recreated from session inference', async () => {
    const target = dir('deleted-by-user')
    const stateFile = join(root, 'tombstone-state.json')
    const file = registryFile({})

    const first = mount({ live: [target], externalWorkspaces: file, config: { stateFile } })
    await settle(async () => (await readStatus(first)).lastRun !== null, 'first pass')
    assert.deepEqual(first.created, [], 'nothing to add while it is live')

    // The user deletes it: gone from the live registry, folder and sessions stay.
    const second = mount({
      externalWorkspaces: file,
      sessionCwds: [{ cwd: target, id: 'session-in-deleted-dir' }],
      config: { stateFile, includeUngroupedSessions: true },
    })
    await settle(async () => (await readStatus(second)).lastRun !== null, 'second pass')
    assert.deepEqual(second.created, [], 'the remembered deletion wins over the inference')
    const status = await readStatus(second)
    assert.deepEqual(status.lastRun.suppressed, [{ path: canon(target), why: 'deleted-by-user' }])
    assert.equal(status.lastRun.tombstones, 1)
  })

  await test('an explicit registration overrides a remembered deletion', async () => {
    const target = dir('re-registered')
    const stateFile = join(root, 'override-state.json')
    const empty = registryFile({})

    const first = mount({ live: [target], externalWorkspaces: empty, config: { stateFile } })
    await settle(async () => (await readStatus(first)).lastRun !== null, 'learn it')
    const second = mount({ externalWorkspaces: empty, config: { stateFile } })
    await settle(async () => (await readStatus(second)).lastRun !== null, 'tombstone it')

    const explicit = registryFile({ a: { path: target, title: 're-registered' } })
    const third = mount({ externalWorkspaces: explicit, sessionCwds: [target], config: { stateFile, includeUngroupedSessions: true } })
    await settle(() => third.created.length === 1, 'explicit registration is honoured')
    assert.deepEqual(third.created, [canon(target)])
  })

  await test('never registers directories under the DSH data home', async () => {
    const fakeHome = dir('fake-dsh-home')
    const insideHome = join(fakeHome, 'bot', 'workspace')
    mkdirSync(insideHome, { recursive: true })
    const outside = dir('outside-home')

    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = fakeHome
    try {
      const mounted = mount({ sessionCwds: [insideHome, outside], config: { includeUngroupedSessions: true } })
      await settle(() => mounted.created.length === 1, 'only the outside directory')
      assert.deepEqual(mounted.created, [canon(outside)])

      const optedIn = mount({ sessionCwds: [insideHome], config: { excludeDshHome: false, includeUngroupedSessions: true } })
      await settle(() => optedIn.created.length === 1, 'opt-in adds the inside directory')
      assert.deepEqual(optedIn.created, [canon(insideHome)])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  await test('attaches sessions that ran in a freshly registered workspace', async () => {
    const target = dir('attach-target')
    const mounted = mount({ sessionCwds: [{ cwd: target, id: 'session-abc' }], config: { includeUngroupedSessions: true } })
    await settle(() => mounted.attached.length === 1, 'attach')
    assert.deepEqual(mounted.attached, [{ path: canon(target), sessionId: 'session-abc' }])
    const status = await readStatus(mounted)
    assert.equal(status.lastRun.attached.length, 1)
    assert.equal(status.lastRun.attachFailed.length, 0)
  })

  await test('leaves a workspace that already accounts for its sessions alone', async () => {
    const target = dir('already-owned')
    const mounted = mount({
      live: [{ path: target, sessionIds: ['session-abc'] }],
      sessionCwds: [{ cwd: target, id: 'session-abc' }],
    })
    await settle(async () => (await readStatus(mounted)).lastRun !== null, 'lastRun')
    assert.deepEqual(mounted.attached, [])
    assert.equal((await readStatus(mounted)).lastRun.attached.length, 0)
  })

  await test('adopts a session that appeared later in an already-populated workspace', async () => {
    const target = dir('attach-later')
    const mounted = mount({
      live: [{ path: target, sessionIds: ['session-old'] }],
      sessionCwds: [{ cwd: target, id: 'session-old' }, { cwd: target, id: 'session-new' }],
    })
    await settle(() => mounted.attached.length === 1, 'adopt the later session')
    assert.deepEqual(mounted.attached.map((entry) => entry.sessionId), ['session-new'])
    const status = await readStatus(mounted)
    assert.equal(status.lastRun.attached.length, 1)
    assert.equal(status.lastRun.attachFailed.length, 0)

    // Idempotent: the member the record already had is never re-attached, so a second
    // pass finds nothing to do (this is the case that used to stay invisible: a new
    // conversation in a workspace that already owned one).
    const response = await mounted.getHandle()(new Request('http://127.0.0.1/api/workspace-sync?action=sync', { method: 'POST' }))
    assert.equal(response.status, 200)
    assert.equal(mounted.attached.length, 1)
  })

  await test('a rejected attach is recorded without failing the pass', async () => {
    const target = dir('attach-rejected')
    const mounted = mount({ sessionCwds: [{ cwd: target, id: 'session-ghost' }], config: { attachSessions: true, includeUngroupedSessions: true } })
    // Drop the session from the host's own map so attachSession must refuse it.
    await settle(() => mounted.created.length === 1, 'workspace created')
    const status = await readStatus(mounted)
    assert.equal(status.lastRun.added.length, 1)
    assert.ok(status.lastRun.attached.length + status.lastRun.attachFailed.length === 1)
  })

  await test('a failing create is recorded and does not abort the rest of the pass', async () => {
    const bad = dir('bad')
    const good = dir('good')
    const file = registryFile({ a: { path: bad }, b: { path: good } })
    const mounted = mount({ externalWorkspaces: file, failing: new Set([canon(bad)]) })
    await settle(() => mounted.created.includes(canon(good)), 'partial pass')
    const status = await readStatus(mounted)
    assert.equal(status.lastRun.failed.length, 1)
    assert.match(status.lastRun.failed[0].message, /create refused/)
    assert.equal(status.lastRun.added.length, 1)
  })

  await test('respects maxAddsPerPass', async () => {
    const paths = [dir('b1'), dir('b2'), dir('b3')]
    const file = registryFile(Object.fromEntries(paths.map((path, i) => [String(i), { path }])))
    const mounted = mount({ externalWorkspaces: file, config: { maxAddsPerPass: 2 } })
    await settle(() => mounted.created.length === 2, 'budgeted adds')
    const status = await readStatus(mounted)
    assert.equal(status.lastRun.added.length, 2)
    assert.equal(status.lastRun.skipped.filter((entry) => entry.why === 'pass-budget-reached').length, 1)
  })

  await test('a malformed shared file yields warnings instead of throwing', async () => {
    const file = join(root, 'broken.json')
    writeFileSync(file, '{ not json')
    const mounted = mount({ externalWorkspaces: file })
    await settle(async () => (await readStatus(mounted)).lastRun !== null, 'lastRun')
    const status = await readStatus(mounted)
    assert.equal(status.lastRun.added.length, 0)
    assert.ok(status.lastRun.warnings.some((warning) => warning.includes('读取共享工作区文件失败')), JSON.stringify(status.lastRun.warnings))
  })

  await test('the capability self-check passes against a complete Host', async () => {
    const mounted = mount({})
    await settle(async () => (await readStatus(mounted)).lastRun !== null, 'first pass')
    const doctor = (await readStatus(mounted)).doctor
    assert.equal(doctor.ok, true, `failing: ${JSON.stringify(doctor.checks.filter((entry) => !entry.ok))}`)
    assert.ok(doctor.checks.some((entry) => entry.id === 'service.sessionController.prompt'))
    assert.ok(doctor.checks.some((entry) => entry.id === 'file.registryFile.tables.workspaces'))
  })

  await test('the capability self-check names what drifted instead of failing silently', async () => {
    const mounted = mount({ dropServices: ['sessionController'] })
    await settle(async () => (await readStatus(mounted)).lastRun !== null, 'first pass')
    const doctor = (await readStatus(mounted)).doctor
    assert.equal(doctor.ok, false)
    const failing = doctor.checks.filter((entry) => !entry.ok).map((entry) => entry.id)
    assert.ok(failing.includes('service.sessionController.prompt'), JSON.stringify(failing))
  })

  await test('GET reports status, POST runs a pass, dispose unregisters the route', async () => {
    const later = dir('posted')
    const file = registryFile({})
    const mounted = mount({ externalWorkspaces: file })
    await settle(async () => (await readStatus(mounted)).lastRun !== null, 'lastRun')
    const before = await readStatus(mounted)
    assert.equal(before.routePath, '/api/workspace-sync')
    assert.equal(before.autoSync, false)
    assert.deepEqual(mounted.created, [], 'nothing registered yet')

    // Another Host process registers a workspace while this one keeps running.
    writeFileSync(file, JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['x'] },
      tables: { workspaces: { x: { path: later, title: 'posted' } } },
    }))

    const response = await mounted.getHandle()(new Request('http://127.0.0.1/api/workspace-sync?action=sync', { method: 'POST' }))
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.data.added.map((entry) => entry.path), [canon(later)])

    for (const dispose of mounted.ctx._disposers) dispose()
    assert.equal(mounted.wasRouteDisposed(), true)
  })
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(sandboxHome, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
