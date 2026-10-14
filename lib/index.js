/**
 * @module dsh-plugin-codex-bridge (host half)
 *
 * Keeps THIS Host's live workspace registry in step with work that other DSH
 * processes committed to the shared data directory — so a workspace created by
 * an external driver (a CLI/Web host that an agent talks to over the local RPC)
 * shows up in the running desktop sidebar without restarting the app.
 *
 * Why this is needed (measured on this machine, 2026-10-13):
 *   - `~/.dsh/sessions/` and `~/.dsh/storages/workspace.json` are shared by every
 *     Host that runs as the same OS user: profile directories only isolate
 *     configuration and plugins, never session or workspace data.
 *   - The workspace registry bootstraps from session history exactly once (when
 *     it is empty) and never rescans afterwards. Its own docs call this out:
 *     "外部变更延迟可见——如果另一进程删除或损坏目录，项目只能在下次刷新或重启后
 *     反映出来". A live desktop therefore keeps showing "未分组" for sessions whose
 *     workspace another process registered.
 *   - Two live Hosts also clobber each other: whoever writes the domain file last
 *     wins, so an external registration can be erased by any later desktop write.
 *     This plugin re-asserts the external truth on a timer, which makes it
 *     self-healing in both directions.
 *
 * Design choices (deliberately matching dsh-git-graph / dsh-token-stats, the two
 * path-installed plugins that already work in this profile):
 *   - ZERO bare package imports: a profile-installed path package cannot resolve
 *     `@deepseek-ai/*` or `zod` from its own location, so this half uses only
 *     `node:` builtins plus services reached through `ctx`.
 *   - No schemastery `Config`: the loader row's `config` is read defensively and
 *     reported as warnings instead of failing the mount.
 *   - `connection` is declared in `inject`, not merely read with `ctx.get`: on a
 *     cold boot the web carrier registers later than the session services, and a
 *     plugin that only reads it during apply silently loses its route.
 *   - Additive only. Nothing here ever renames, reorders, archives or deletes a
 *     workspace; it only creates registrations that are missing locally and whose
 *     directory still exists on disk.
 *   - It remembers deletions. A workspace that leaves the live registry was removed
 *     by the user, and its folder plus session history outlive it — so an inferred
 *     candidate for that path would recreate it on the next pass, which reads as
 *     "the refresh button brought back what I deleted". Those paths go into a
 *     persisted tombstone list (`stateFile`) and are never re-registered from
 *     inference again; an explicit registration still overrides the list.
 *
 * The same half also runs a file-drop relay (`lib/inbox.js`) so an external
 * driver can hand work to a Session THIS Host already owns. A Session has one
 * writer: while the desktop window holds `session.lock`, any other Host writing
 * it fails with `session/writer-held` — by design. The owner is therefore the
 * only party that can deliver into it, so requests are dropped as JSON files in
 * `<DSH_HOME>/inbox/` and delivered here through `sessionController.prompt` with
 * `mode: 'queue'` (waiting for the current turn to finish). `steer` is refused
 * unless explicitly enabled, and nothing here cancels or interrupts anything.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { createInbox, readInboxConfig } from './inbox.js'

/** Cordis plugin name. */
const name = 'workspace-sync'

/** Required services (see the module docblock for why `connection` is here). */
const inject = ['connection', 'workspaceRegistry', 'sessionQuery']

const DEFAULT_CONFIG = {
  routePath: '/api/workspace-sync',
  registryFile: null,
  stateFile: null,
  autoSync: true,
  intervalMs: 5000,
  // OFF by default on purpose. Turning this on infers workspaces from session
  // directories, and a DELETED workspace keeps both its directory and its
  // sessions — so the inference would resurrect it on the next pass. Explicit
  // registrations (another Host writing the shared file) are the safe source.
  includeUngroupedSessions: false,
  attachSessions: true,
  clientRefresh: true,
  excludeDshHome: true,
  maxAddsPerPass: 20,
  verbose: false,
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Coerce one numeric field, clamped to a safe range; never throws. */
const clampInt = (value, fallback, min, max) => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * Resolve the loader row's raw config into a fully defaulted object.
 *
 * @param raw - the row's `config` as declared in the profile patch (any shape).
 * @returns the effective config plus warnings for ignored keys.
 */
const readConfig = (raw) => {
  const warnings = []
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULT_CONFIG }

  if (input.routePath !== undefined) {
    if (typeof input.routePath === 'string' && input.routePath.startsWith('/api/')) cfg.routePath = input.routePath
    else warnings.push('routePath 必须以 /api/ 开头，已回落到默认值')
  }
  if (typeof input.registryFile === 'string' && input.registryFile.length > 0) cfg.registryFile = input.registryFile
  if (typeof input.stateFile === 'string' && input.stateFile.length > 0) cfg.stateFile = input.stateFile
  if (typeof input.autoSync === 'boolean') cfg.autoSync = input.autoSync
  if (typeof input.includeUngroupedSessions === 'boolean') cfg.includeUngroupedSessions = input.includeUngroupedSessions
  if (typeof input.excludeDshHome === 'boolean') cfg.excludeDshHome = input.excludeDshHome
  if (typeof input.attachSessions === 'boolean') cfg.attachSessions = input.attachSessions
  if (typeof input.clientRefresh === 'boolean') cfg.clientRefresh = input.clientRefresh
  if (typeof input.verbose === 'boolean') cfg.verbose = input.verbose
  cfg.intervalMs = clampInt(input.intervalMs, DEFAULT_CONFIG.intervalMs, 1000, 600000)
  cfg.maxAddsPerPass = clampInt(input.maxAddsPerPass, DEFAULT_CONFIG.maxAddsPerPass, 1, 200)

  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_CONFIG) && key !== 'inbox') warnings.push(`未知配置项已忽略：${key}`)
  }
  return { cfg, warnings }
}

/** The shared DSH data directory (`$DSH_HOME`, else `~/.dsh`). */
const dshHomeDir = () => {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * Canonical absolute path used as the identity of a workspace.
 *
 * The registry itself canonicalises with `fs.realpath`; matching that here is
 * what keeps a symlinked registration and its target from being added twice.
 * Never throws: a path that cannot be realpath'd (missing, racing deletion) still
 * gets a resolved form so it can be compared and rejected by the directory check.
 */
const canonicalPath = (value) => {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!isAbsolute(value)) return null
  try {
    return realpathSync(value)
  } catch {
    return resolvePath(value)
  }
}

/** Whether `path` is an existing directory. Never throws. */
const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// external truth
// ---------------------------------------------------------------------------

/**
 * Workspaces committed to the shared domain file by ANY Host process.
 *
 * Read as a plain file on purpose: reading it through a service would return this
 * process's own in-memory copy, which is exactly the state we are reconciling.
 *
 * @param file - absolute path of `storages/workspace.json`.
 * @returns `{ list, warnings }`; a malformed file yields an empty list.
 */
const readExternalWorkspaces = (file) => {
  const list = []
  const warnings = []
  try {
    if (!existsSync(file)) {
      warnings.push(`未找到共享工作区文件：${file}`)
      return { list, warnings }
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const table = parsed?.tables?.workspaces
    if (table === null || typeof table !== 'object') {
      warnings.push('共享工作区文件缺少 tables.workspaces')
      return { list, warnings }
    }
    for (const entry of Object.values(table)) {
      const path = typeof entry?.path === 'string' ? entry.path : null
      if (path === null || path.length === 0) continue
      list.push({
        path,
        title: typeof entry?.title === 'string' ? entry.title : null,
        updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
      })
    }
  } catch (error) {
    warnings.push(`读取共享工作区文件失败：${String(error?.message ?? error)}`)
  }
  return { list, warnings }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * Mount the plugin.
 *
 * @param ctx - the Cordis context of this plugin's fiber.
 * @param rawConfig - the loader row's raw `config` (optional, unvalidated).
 */
function apply(ctx, rawConfig) {
  const { cfg, warnings: configWarnings } = readConfig(rawConfig)
  if (cfg.registryFile === null) cfg.registryFile = join(dshHomeDir(), 'storages', 'workspace.json')
  if (cfg.stateFile === null) cfg.stateFile = join(dshHomeDir(), 'workspace-sync', 'state.json')
  const { cfg: inboxCfg, warnings: inboxWarnings } = readInboxConfig(rawConfig?.inbox)
  if (inboxCfg.dir === null) inboxCfg.dir = join(dshHomeDir(), 'inbox')

  const log = (level, ...args) => {
    try {
      const logger = ctx.logger
      if (typeof logger?.[level] === 'function') logger[level](...args)
      else if (level === 'error') console.error(...args)
      else if (cfg.verbose) console.log(...args)
    } catch {
      /* logging must never break the sync */
    }
  }

  let lastRun = null
  let inflight = null
  let disposed = false

  // What this plugin knows about the workspaces it has seen: `lastSeen` lets the
  // next pass (and the next process) tell "deleted by the user" apart from "never
  // had a workspace", and `tombstones` is the resulting do-not-recreate list.
  const loadState = () => {
    try {
      const raw = JSON.parse(readFileSync(cfg.stateFile, 'utf8'))
      return {
        lastSeen: Array.isArray(raw?.lastSeen) ? raw.lastSeen.filter((path) => typeof path === 'string') : [],
        tombstones: Array.isArray(raw?.tombstones) ? raw.tombstones.filter((path) => typeof path === 'string') : [],
      }
    } catch {
      return { lastSeen: [], tombstones: [] }
    }
  }
  const state = loadState()
  let lastStateBody = ''

  /** Persist the deletion memory; a failure only means it is relearned later. */
  const persistState = () => {
    try {
      const body = `${JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        lastSeen: state.lastSeen,
        tombstones: state.tombstones,
      }, null, 2)}\n`
      if (body === lastStateBody) return
      mkdirSync(dirname(cfg.stateFile), { recursive: true, mode: 0o700 })
      const tmp = `${cfg.stateFile}.tmp-${process.pid}`
      writeFileSync(tmp, body, { mode: 0o600 })
      renameSync(tmp, cfg.stateFile)
      lastStateBody = body
    } catch (error) {
      log('warn', `workspace-sync：写入状态文件失败：${String(error?.message ?? error)}`)
    }
  }

  // The relay must exist even when the workspace sync is off: it is the only
  // channel that can reach a Session this Host already owns.
  const inbox = inboxCfg.enabled ? createInbox({ ctx, cfg: inboxCfg, log }) : null

  // Paths under the DSH data directory are harness plumbing (the bot workspace,
  // caches, session logs), never the user's projects: never register them. An
  // entry that is already in the live registry is untouched either way.
  const excludeRoots = cfg.excludeDshHome ? [canonicalPath(dshHomeDir())] : []
  const isExcluded = (path) =>
    excludeRoots.some((root) => typeof root === 'string' && (path === root || path.startsWith(`${root}/`)))

  // ---- capability self-check -----------------------------------------------
  //
  // Everything here rests on Host contracts that carry no stability promise:
  // service shapes, the shared domain file, the writable data directories. A DSH
  // upgrade can move any of them, and this plugin deliberately declares no
  // `@deepseek-ai/dsh-*` peer dependency (that is what lets it install on any
  // version), so nothing else would notice. Checking the shape at runtime and
  // shouting when it drifts is the replacement for a version gate.
  let lastDoctor = null
  let lastDoctorSignature = null

  const runDoctor = () => {
    const checks = []
    const check = (id, ok, detail) => {
      checks.push({ id, ok: ok === true, ...(detail === undefined ? {} : { detail }) })
    }
    const writable = (path) => {
      try {
        mkdirSync(path, { recursive: true, mode: 0o700 })
        return true
      } catch {
        return false
      }
    }

    const registry = ctx.get('workspaceRegistry')
    check('service.workspaceRegistry.create', typeof registry?.create === 'function')
    check('service.workspaceRegistry.list', typeof registry?.list === 'function')
    const controller = ctx.get('sessionController')
    check('service.sessionController.prompt', typeof controller?.prompt === 'function')
    check('service.sessionController.list', typeof controller?.list === 'function')
    check('service.sessionQuery.listSessions', typeof ctx.get('sessionQuery')?.listSessions === 'function')
    check('service.connection.fetch.register', typeof ctx.get('connection')?.fetch?.register === 'function')

    check('file.registryFile.exists', existsSync(cfg.registryFile), cfg.registryFile)
    let registryShape = false
    try {
      const parsed = JSON.parse(readFileSync(cfg.registryFile, 'utf8'))
      registryShape = parsed?.tables?.workspaces !== null && typeof parsed?.tables?.workspaces === 'object'
    } catch {
      registryShape = false
    }
    check('file.registryFile.tables.workspaces', registryShape, cfg.registryFile)

    check('dir.stateFile.writable', writable(dirname(cfg.stateFile)), cfg.stateFile)
    if (inbox !== null) check('dir.inbox.writable', writable(inboxCfg.dir), inboxCfg.dir)

    // The reconciler calls `create()` and then reads the entity's `sessionIds` /
    // `attachSession`, so the list items must still look like workspace entities.
    try {
      const items = registry?.list?.() ?? []
      const sample = items[0]
      check('entity.workspace.path', items.length === 0 || typeof sample?.path === 'string', `sampled ${items.length}`)
    } catch (error) {
      check('entity.workspace.path', false, String(error?.message ?? error))
    }

    lastDoctor = { at: Date.now(), ok: checks.every((entry) => entry.ok), checks }
    const failing = checks.filter((entry) => !entry.ok).map((entry) => entry.id).join(', ')
    if (failing !== lastDoctorSignature) {
      lastDoctorSignature = failing
      if (failing.length === 0) log('info', 'workspace-sync：能力自检通过（服务与共享文件契约齐全）')
      else log('error', `workspace-sync：能力自检失败：${failing} —— DSH 内部契约可能已漂移，插件将降级运行`)
    }
    return lastDoctor
  }

  /**
   * One reconciliation pass: every workspace that exists in the shared file (or,
   * optionally, every directory a recorded session ran in) but is missing from
   * this Host's live registry is created here.
   *
   * Creating through the registry service is the whole point: it persists the
   * record AND publishes it on the workspace follow stream, which is what updates
   * an already-open sidebar.
   */
  const runSync = async (reason) => {
    const started = Date.now()
    const result = {
      reason,
      at: started,
      elapsedMs: 0,
      external: 0,
      sessionOnly: 0,
      alreadyRegistered: 0,
      added: [],
      attached: [],
      attachFailed: [],
      suppressed: [],
      tombstones: 0,
      skipped: [],
      failed: [],
      warnings: [],
    }

    const registry = ctx.get('workspaceRegistry')
    if (registry?.list === undefined || registry?.create === undefined) {
      result.warnings.push('workspaceRegistry 服务不可用，本轮跳过')
      lastRun = result
      return result
    }

    // 1. this Host's live view
    const live = new Map()
    try {
      for (const item of registry.list() ?? []) {
        const path = typeof item === 'string' ? item : item?.path
        const key = canonicalPath(path)
        if (key !== null) live.set(key, item)
      }
    } catch (error) {
      result.warnings.push(`读取本地工作区列表失败：${String(error?.message ?? error)}`)
    }

    // 2. remember what the user removed.
    //
    // Deleting a workspace keeps its folder AND its session history, so a
    // deleted directory immediately looks exactly like the "session ran here but
    // no workspace covers it" case this plugin also repairs. Without a memory of
    // the deletion, the repair would resurrect it on the next pass — which is
    // precisely what a user sees as "the refresh button brings back what I
    // deleted". Any path that leaves the live registry is therefore recorded as
    // deleted-by-the-user and is never re-registered from an INFERRED candidate.
    // An explicit registration (a Host writing it into the shared file) still
    // wins: that is a deliberate instruction, not an inference.
    const tombstones = new Set(state.tombstones)
    for (const path of state.lastSeen) {
      if (!live.has(path)) tombstones.add(path)
    }
    for (const path of live.keys()) tombstones.delete(path)

    // 3. candidate paths, in priority order
    const candidates = new Map()
    const addCandidate = (path, title, source) => {
      const key = canonicalPath(path)
      if (key === null || candidates.has(key) || isExcluded(key)) return
      if (source === 'session' && tombstones.has(key)) {
        result.suppressed.push({ path: key, why: 'deleted-by-user' })
        return
      }
      candidates.set(key, { path: key, title, source })
    }

    const external = readExternalWorkspaces(cfg.registryFile)
    result.warnings.push(...external.warnings)
    result.external = external.list.length
    for (const item of external.list) addCandidate(item.path, item.title, 'registry')

    // Sessions are read once and used twice: as extra candidate directories
    // (a session that ran in a directory no workspace covers is exactly the
    // "未分组" case), and as the membership account for workspaces that have none.
    const sessionsByPath = new Map()
    if (cfg.includeUngroupedSessions || cfg.attachSessions) {
      try {
        const records = await ctx.get('sessionQuery')?.listSessions?.()
        for (const record of records ?? []) {
          const cwd = record?.header?.cwd
          const sessionId = record?.header?.id ?? record?.id
          if (typeof cwd !== 'string' || cwd.length === 0) continue
          const key = canonicalPath(cwd)
          if (key === null) continue
          if (typeof sessionId === 'string' && sessionId.length > 0) {
            const bucket = sessionsByPath.get(key)
            if (bucket === undefined) sessionsByPath.set(key, [sessionId])
            else bucket.push(sessionId)
          }
          if (cfg.includeUngroupedSessions) addCandidate(cwd, null, 'session')
        }
      } catch (error) {
        result.warnings.push(`读取会话记录失败：${String(error?.message ?? error)}`)
      }
    }
    for (const candidate of candidates.values()) {
      if (candidate.source === 'session' && !live.has(candidate.path)) result.sessionOnly += 1
    }

    // 4. create what is missing
    let added = 0
    for (const candidate of candidates.values()) {
      if (live.has(candidate.path)) {
        result.alreadyRegistered += 1
        continue
      }
      if (added >= cfg.maxAddsPerPass) {
        result.skipped.push({ path: candidate.path, why: 'pass-budget-reached' })
        continue
      }
      if (!isDirectory(candidate.path)) {
        result.skipped.push({ path: candidate.path, why: 'not-a-directory' })
        continue
      }
      try {
        const workspace = await registry.create(candidate.path)
        added += 1
        live.set(candidate.path, workspace)
        result.added.push({ path: candidate.path, title: candidate.title, source: candidate.source })
        // An explicit registration is a deliberate instruction: it overrides a
        // remembered deletion (the user, or another Host, wants it back).
        if (candidate.source === 'registry') tombstones.delete(candidate.path)
      } catch (error) {
        result.failed.push({ path: candidate.path, message: String(error?.message ?? error) })
      }
    }

    // 5. remember this pass: what is live now, and what the user has removed.
    result.tombstones = tombstones.size
    state.lastSeen = [...live.keys()].slice(0, 2000)
    state.tombstones = [...tombstones].slice(-500)
    persistState()

    // 6. report whether the Host still looks like the Host this plugin was built
    // against. Cheap (a few stats and shape reads) and the only early warning a
    // plugin without a declared version constraint can offer.
    result.doctor = runDoctor()

    // 6. account the sessions that actually ran in each workspace.
    //
    // Membership in this registry is ownership plus a live-cwd fact: the record's
    // `sessionIds` is the ownership account, so a session whose cwd matches but which
    // no record lists keeps showing under "未分组". Sessions made by the OTHER Host
    // were accounted in that Host's copy — which this process never saw — so they are
    // re-asserted here, for EVERY workspace rather than only for empty ones: a
    // conversation started later inside an already-populated workspace is exactly the
    // case that used to slip through and stay invisible in the desktop.
    //
    // Safe to do for a populated record: `attachSession` re-runs the registry's own
    // validation (header cwd must resolve to the record's path) so an unfitting
    // session is rejected rather than forced in, members already on the account are
    // skipped (idempotent), and the client exposes no way to detach a session from a
    // workspace — so this can only ever add the grouping the path already implies.
    if (cfg.attachSessions) {
      for (const [path, workspace] of live) {
        if (typeof workspace?.attachSession !== 'function') continue
        const owned = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        const sessionIds = sessionsByPath.get(path)
        if (sessionIds === undefined) continue
        for (const sessionId of sessionIds) {
          if (owned.includes(sessionId)) continue
          try {
            await workspace.attachSession(sessionId)
            owned.push(sessionId)
            result.attached.push({ path, sessionId })
          } catch (error) {
            result.attachFailed.push({ path, sessionId, message: String(error?.message ?? error) })
          }
        }
      }
    }

    // Tell the client half whether it may reload this window after a changing pass.
    result.clientRefresh = cfg.clientRefresh
    result.elapsedMs = Date.now() - started
    lastRun = result
    if (result.added.length > 0 || result.failed.length > 0 || result.attached.length > 0 || cfg.verbose) {
      log(
        'info',
        `workspace-sync[${reason}]：新增 ${result.added.length} 个，归组 ${result.attached.length} 条会话，`
        + `已在册 ${result.alreadyRegistered} 个，跳过 ${result.skipped.length} 个，`
        + `尊重已删除 ${result.suppressed.length} 个（累计 ${result.tombstones}），`
        + `失败 ${result.failed.length + result.attachFailed.length} 个（${result.elapsedMs}ms）`,
      )
    }
    return result
  }

  /** Serialise passes: a manual refresh never races the timer. */
  const sync = (reason) => {
    if (inflight !== null) return inflight
    const task = runSync(reason)
    inflight = task
    // `finally` keeps the promise chain clean without swallowing the result.
    task.then(
      () => { if (inflight === task) inflight = null },
      () => { if (inflight === task) inflight = null },
    )
    return task
  }

  // ---- route ----------------------------------------------------------------
  const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

  const handle = async (request) => {
    const started = Date.now()
    let url = null
    try {
      url = new URL(request?.url ?? '/', 'http://127.0.0.1')
    } catch {
      url = null
    }
    const action = url?.searchParams?.get('action') ?? null

    try {
      if (request?.method === 'POST' && action === 'sync') {
        const data = await sync('manual')
        return jsonResponse(200, { ok: true, data, meta: { elapsedMs: Date.now() - started } })
      }
      if (action === 'sync') {
        return jsonResponse(200, { ok: true, data: await sync('manual'), meta: { elapsedMs: Date.now() - started } })
      }
      if (request?.method === 'POST' && action === 'inbox') {
        const results = await inbox?.drain('manual') ?? []
        await inbox?.refreshIndex(true)
        return jsonResponse(200, { ok: true, data: { results, status: inbox?.status() ?? null }, meta: { elapsedMs: Date.now() - started } })
      }
      if (action === 'doctor') {
        return jsonResponse(200, { ok: true, data: runDoctor(), meta: { elapsedMs: Date.now() - started } })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          routePath: cfg.routePath,
          registryFile: cfg.registryFile,
          autoSync: cfg.autoSync,
          intervalMs: cfg.intervalMs,
          includeUngroupedSessions: cfg.includeUngroupedSessions,
          lastRun,
          doctor: lastDoctor,
          inbox: inbox?.status() ?? { enabled: false },
        },
        meta: { elapsedMs: Date.now() - started },
      })
    } catch (error) {
      return jsonResponse(500, {
        ok: false,
        error: { code: 'SYNC_FAILED', message: String(error?.message ?? error) },
        meta: { elapsedMs: Date.now() - started },
      })
    }
  }

  let disposeRoute = null
  try {
    const connection = ctx.get('connection')
    if (connection?.fetch?.register !== undefined) {
      disposeRoute = connection.fetch.register({
        path: cfg.routePath,
        methods: ['GET', 'POST'],
        fetch: handle,
      })
    } else {
      const webServer = ctx.get('webServer')
      if (webServer?.register !== undefined) {
        const nodeAdapter = (handler) => async (req, res) => {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const response = await handler(new Response(chunks.length > 0 ? Buffer.concat(chunks) : undefined, {
            method: req.method,
            headers: { host: req.headers.host ?? '127.0.0.1' },
          }))
          res.statusCode = response.status
          for (const [key, value] of response.headers) res.setHeader(key, value)
          res.end(Buffer.from(await response.arrayBuffer()))
        }
        disposeRoute = webServer.register({ kind: 'exact', path: cfg.routePath, handler: nodeAdapter(handle) })
      }
    }
  } catch (error) {
    log('error', `workspace-sync：注册路由失败：${String(error?.message ?? error)}`)
  }
  if (typeof disposeRoute !== 'function') {
    log('error', `workspace-sync：未能注册 ${cfg.routePath}，按钮将不可用（自动同步照常）`)
  }

  ctx.effect(() => () => {
    try {
      disposeRoute?.()
    } catch {
      /* ignore */
    }
  }, 'workspace-sync: route')

  // ---- timer ----------------------------------------------------------------
  let timer = null
  if (cfg.autoSync) {
    timer = setInterval(() => {
      if (disposed) return
      void sync('timer').catch(() => { /* errors are recorded in lastRun */ })
    }, cfg.intervalMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  // The relay runs on its own (faster) cadence so a dropped instruction is picked
  // up in about a second without making the workspace scan any busier.
  let inboxTimer = null
  if (inbox !== null) {
    inboxTimer = setInterval(() => {
      if (disposed) return
      void inbox.drain('timer').catch(() => { /* outcomes live in the receipts */ })
      void inbox.refreshIndex().catch(() => { /* the index is advisory */ })
    }, inboxCfg.intervalMs)
    if (typeof inboxTimer?.unref === 'function') inboxTimer.unref()
  }

  ctx.effect(() => () => {
    disposed = true
    if (timer !== null) clearInterval(timer)
    if (inboxTimer !== null) clearInterval(inboxTimer)
    timer = null
    inboxTimer = null
  }, 'workspace-sync: timers')

  // First pass immediately: a freshly mounted plugin fixes the sidebar at once,
  // and an instruction dropped while the app was closed is delivered right away.
  void sync('mount').catch(() => { /* errors are recorded in lastRun */ })
  if (inbox !== null) {
    void inbox.drain('mount').catch(() => { /* outcomes live in the receipts */ })
    void inbox.refreshIndex(true).catch(() => { /* the index is advisory */ })
  }

  for (const warning of [...configWarnings, ...inboxWarnings]) log('warn', `workspace-sync：${warning}`)
  log(
    'info',
    `workspace-sync：已挂载（${cfg.routePath}，自动同步 ${cfg.autoSync ? `${cfg.intervalMs}ms` : '关闭'}，`
    + `会话目录 ${cfg.includeUngroupedSessions ? '参与' : '不参与'}，`
    + `投递箱 ${inbox === null ? '关闭' : `${inboxCfg.dir} / ${inboxCfg.intervalMs}ms / steer ${inboxCfg.allowSteer ? '允许' : '禁止'}`}）`,
  )
}

export { apply, inject, name }
