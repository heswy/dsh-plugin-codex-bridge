/**
 * @module dsh-plugin-codex-bridge/inbox (host half)
 *
 * A file-drop relay: another process (an external agent driver such as codex)
 * writes one JSON file, and THIS Host — the one that actually owns the Session
 * and holds its writer lock — delivers it as a prompt.
 *
 * Why a relay instead of a direct call: a Session has exactly one writer. When
 * the desktop window has a Session open, that process holds `session.lock`, and
 * any other Host that tries to write it fails with `session/writer-held` (by
 * design — two writers would corrupt the log). The owning Host is the only party
 * that can deliver into it, so the message is dropped in a shared directory that
 * the owner watches. No credentials, no lock stealing, no second writer.
 *
 * Safety stance — this relay exists to hand work to the owner, never to disturb
 * it:
 *   - `mode: 'queue'` is the only delivery mode allowed by default: the prompt
 *     waits in the session inbox and is claimed at the next turn boundary, so a
 *     turn that is already running is untouched.
 *   - `mode: 'steer'` (interjecting into a running turn) is REJECTED unless
 *     `allowSteer` is explicitly enabled in the profile patch.
 *   - Nothing here cancels, interrupts, archives, renames or locks anything.
 *   - A failed delivery is recorded in a receipt and the request is consumed —
 *     it is never retried in a loop against a busy Session.
 *
 * Wire format — `$DSH_HOME/inbox/<anything>.json`:
 *   {
 *     "sessionId": "session-7502f96e-…",   // required
 *     "text": "…",                          // required, non-empty
 *     "mode": "queue",                      // optional, default "queue"
 *     "id": "codex-2026-10-13-1",           // optional idempotency key (file name)
 *     "from": "codex"                       // optional, echoed into the receipt
 *   }
 *
 * Outcomes:
 *   receipts/<id>.json    one per consumed request: { ok, accepted, mode, … }
 *   rejected/<id>.json    malformed or refused requests, moved aside untouched
 *   sessions.json         refreshed index of deliverable Sessions (id/cwd/running)
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Defaults; the caller resolves `dir` (normally `<DSH_HOME>/inbox`). */
export const DEFAULT_INBOX = {
  enabled: true,
  dir: null,
  intervalMs: 1000,
  allowSteer: false,
  maxTextBytes: 200000,
  indexIntervalMs: 10000,
  deliveryTimeoutMs: 30000,
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

const clampInt = (value, fallback, min, max) => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * Resolve the `inbox` block of the loader row defensively.
 *
 * @param raw - the row's `config.inbox` (any shape).
 * @returns the effective inbox config plus warnings for ignored keys.
 */
export const readInboxConfig = (raw) => {
  const warnings = []
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULT_INBOX }

  if (typeof input.enabled === 'boolean') cfg.enabled = input.enabled
  if (typeof input.dir === 'string' && input.dir.length > 0) cfg.dir = input.dir
  if (typeof input.allowSteer === 'boolean') cfg.allowSteer = input.allowSteer
  cfg.intervalMs = clampInt(input.intervalMs, DEFAULT_INBOX.intervalMs, 200, 600000)
  cfg.maxTextBytes = clampInt(input.maxTextBytes, DEFAULT_INBOX.maxTextBytes, 1, 10_000_000)
  cfg.indexIntervalMs = clampInt(input.indexIntervalMs, DEFAULT_INBOX.indexIntervalMs, 1000, 600000)
  cfg.deliveryTimeoutMs = clampInt(input.deliveryTimeoutMs, DEFAULT_INBOX.deliveryTimeoutMs, 1000, 600000)

  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_INBOX) && key !== 'dir') warnings.push(`未知 inbox 配置项已忽略：${key}`)
  }
  return { cfg, warnings }
}

/** Write a file atomically so a reader never sees a half-written receipt. */
const writeJsonAtomic = (path, value) => {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Build the relay.
 *
 * @param options.ctx - Cordis context (only `get` is used).
 * @param options.cfg - resolved inbox config.
 * @param options.log - `(level, message) => void`.
 */
export const createInbox = ({ ctx, cfg, log }) => {
  const dir = cfg.dir
  const receiptsDir = join(dir, 'receipts')
  const rejectedDir = join(dir, 'rejected')

  let inflight = null
  let lastIndexAt = 0
  let emptyStreak = 0
  const stats = { consumed: 0, delivered: 0, rejected: 0, failed: 0, last: null }

  const ensureDirs = () => {
    for (const path of [dir, receiptsDir, rejectedDir]) {
      if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
    }
  }

  /**
   * Claim pending requests by renaming them: rename is atomic, so two Hosts
   * watching the same directory can never both take the same file.
   */
  const claim = () => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const claimed = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.claim') || name === 'sessions.json') continue
      const from = join(dir, name)
      const to = `${from}.claim`
      try {
        if (!statSync(from).isFile()) continue
        renameSync(from, to)
        claimed.push({ id: name.slice(0, -'.json'.length), path: to, name })
      } catch {
        /* another Host took it, or it vanished mid-scan */
      }
    }
    return claimed
  }

  /** Validate one decoded request; returns `{ request }` or `{ reason }`. */
  const validate = (raw, fallbackId) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'not-an-object' }
    const { sessionId, text } = raw
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { reason: 'bad-session-id' }
    if (typeof text !== 'string' || text.trim().length === 0) return { reason: 'empty-text' }
    if (Buffer.byteLength(text, 'utf8') > cfg.maxTextBytes) return { reason: 'text-too-long' }

    const mode = raw.mode === undefined ? 'queue' : raw.mode
    if (mode !== 'queue' && mode !== 'steer') return { reason: 'bad-mode' }
    if (mode === 'steer' && cfg.allowSteer !== true) return { reason: 'steer-disabled' }

    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : fallbackId
    return {
      request: {
        id,
        sessionId,
        text,
        mode,
        from: typeof raw.from === 'string' ? raw.from.slice(0, 200) : null,
        clientTimeZone: typeof raw.clientTimeZone === 'string' ? raw.clientTimeZone : undefined,
      },
    }
  }

  /** Live Session facts, used only to describe the target in the receipt. */
  const describeSession = async (sessionId) => {
    try {
      const controller = ctx.get('sessionController')
      const value = await controller?.list?.({}, undefined)
      const item = (value?.items ?? []).find((entry) => entry?.sessionId === sessionId)
      if (item === undefined) return { known: false, running: false }
      return {
        known: true,
        running: item.running === true,
        blank: item.blank === true,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : null,
        cwd: typeof item.cwd === 'string' ? item.cwd : null,
      }
    } catch {
      return { known: null, running: null }
    }
  }

  const consume = async (claimed) => {
    const { id, path } = claimed
    const started = Date.now()
    let raw = null
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      stats.consumed += 1
      stats.rejected += 1
      const receipt = {
        ok: false, id, reason: 'unreadable-request', message: String(error?.message ?? error), at: started,
      }
      try {
        writeJsonAtomic(join(receiptsDir, `${id}.json`), receipt)
        renameSync(path, join(rejectedDir, `${id}.json`))
      } catch { /* best effort */ }
      stats.last = receipt
      log('warn', `workspace-sync inbox：请求 ${id} 无法解析，已移入 rejected/`)
      return receipt
    }

    const validated = validate(raw, id)
    if (validated.reason !== undefined) {
      stats.consumed += 1
      stats.rejected += 1
      const receipt = {
        ok: false,
        id,
        reason: validated.reason,
        sessionId: typeof raw?.sessionId === 'string' ? raw.sessionId : null,
        at: started,
        hint: validated.reason === 'steer-disabled'
          ? 'steer 默认禁用（会插话到正在跑的轮次）；如确需，在 profile patch 里设 inbox.allowSteer: true'
          : undefined,
      }
      try {
        writeJsonAtomic(join(receiptsDir, `${id}.json`), receipt)
        renameSync(path, join(rejectedDir, `${id}.json`))
      } catch { /* best effort */ }
      stats.last = receipt
      log('warn', `workspace-sync inbox：请求 ${id} 被拒（${validated.reason}）`)
      return receipt
    }

    const { request } = validated
    const before = await describeSession(request.sessionId)
    const controller = ctx.get('sessionController')
    // `prompt(request, signal)` opens with `signal.throwIfAborted()`, so it needs a
    // REAL AbortSignal — passing undefined fails before the Session is ever
    // reached. The signal also bounds a hung admission: without it a stuck call
    // would keep this relay's single in-flight slot forever.
    const abort = new AbortController()
    let timer = null
    // Aborting the signal is not enough on its own: a call that never settles
    // would leave this relay's single in-flight slot stuck forever. Race the
    // delivery against the deadline, and abort so the Host side also learns the
    // call was abandoned.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort(new Error('delivery timeout'))
        reject(new Error(`delivery timeout after ${cfg.deliveryTimeoutMs}ms`))
      }, cfg.deliveryTimeoutMs)
      if (typeof timer?.unref === 'function') timer.unref()
    })
    void deadline.catch(() => { /* handled by the race below */ })
    let receipt
    try {
      if (typeof controller?.prompt !== 'function') throw new Error('sessionController.prompt 不可用')
      const accepted = await Promise.race([controller.prompt({
        requestId: request.id,
        sessionId: request.sessionId,
        mode: request.mode,
        content: [{ type: 'text', text: request.text }],
        ...(request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }),
      }, abort.signal), deadline])
      stats.consumed += 1
      stats.delivered += 1
      receipt = {
        ok: true,
        id: request.id,
        accepted: accepted?.accepted === true,
        sessionId: request.sessionId,
        mode: request.mode,
        from: request.from,
        // `running: true` means the prompt is waiting for the current turn to
        // finish — it did NOT interrupt anything.
        targetRunning: before.running,
        targetKnown: before.known,
        queuedBehindRunningTurn: before.running === true && request.mode === 'queue',
        elapsedMs: Date.now() - started,
        at: started,
      }
      log('info', `workspace-sync inbox：已投递 ${request.id} → ${request.sessionId}`
        + `${before.running === true && request.mode === 'queue' ? '（目标正在跑，已排队等待本轮结束）' : ''}`)
    } catch (error) {
      stats.consumed += 1
      stats.failed += 1
      receipt = {
        ok: false,
        id: request.id,
        reason: abort.signal.aborted ? 'delivery-timeout' : 'delivery-failed',
        code: error?.code ?? null,
        message: String(error?.message ?? error),
        sessionId: request.sessionId,
        mode: request.mode,
        from: request.from,
        targetRunning: before.running,
        targetKnown: before.known,
        at: started,
      }
      log('warn', `workspace-sync inbox：投递 ${request.id} 失败（${receipt.code ?? 'unknown'}）：${receipt.message}`)
    } finally {
      if (timer !== null) clearTimeout(timer)
    }

    try {
      writeJsonAtomic(join(receiptsDir, `${request.id}.json`), receipt)
      rmSync(path, { force: true })
    } catch { /* best effort */ }
    stats.last = receipt
    return receipt
  }

  /** Serialised drain: never two passes at once, so claims cannot race here. */
  const drain = (reason = 'timer') => {
    if (inflight !== null) return inflight
    const task = (async () => {
      ensureDirs()
      const claimed = claim()
      const results = []
      for (const item of claimed) results.push(await consume(item))
      if (claimed.length > 0) log('info', `workspace-sync inbox[${reason}]：处理 ${claimed.length} 条`)
      return results
    })()
    inflight = task
    task.then(
      () => { if (inflight === task) inflight = null },
      () => { if (inflight === task) inflight = null },
    )
    return task
  }

  /**
   * Refresh `sessions.json` — the index a sender reads instead of parsing DSH
   * internals. Throttled; a failure only means the previous file stays.
   *
   * An unavailable or cold `sessionController` writes NOTHING rather than an
   * empty index: a "0 sessions" file looks authoritative to a sender while
   * actually meaning "this Host is not ready yet", which is exactly the kind of
   * false fact a relay must never publish.
   */
  const refreshIndex = async (force = false) => {
    const now = Date.now()
    if (!force && now - lastIndexAt < cfg.indexIntervalMs) return
    lastIndexAt = now
    try {
      const controller = ctx.get('sessionController')
      if (typeof controller?.list !== 'function') {
        log('warn', 'workspace-sync inbox：sessionController 尚未就绪，本轮不写会话索引')
        lastIndexAt = 0
        return
      }
      const value = await controller.list({}, undefined)
      const items = (value?.items ?? []).map((item) => ({
        sessionId: item?.sessionId,
        cwd: typeof item?.cwd === 'string' ? item.cwd : null,
        running: item?.running === true,
        blank: item?.blank === true,
        updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : null,
        origin: item?.origin ?? null,
      }))
      // A cold boot can answer with an empty list; retry eagerly for a while
      // instead of letting that answer stand for the next ten seconds.
      if (items.length === 0 && emptyStreak < 30) {
        emptyStreak += 1
        lastIndexAt = 0
      } else if (items.length > 0) {
        emptyStreak = 0
      }
      ensureDirs()
      writeJsonAtomic(join(dir, 'sessions.json'), {
        generatedAt: now,
        count: items.length,
        sources: { sessionController: items.length },
        items,
      })
    } catch (error) {
      log('warn', `workspace-sync inbox：刷新会话索引失败：${String(error?.message ?? error)}`)
    }
  }

  const status = () => {
    let pending = 0
    try {
      pending = readdirSync(dir).filter((name) => name.endsWith('.json') && !name.endsWith('.claim') && name !== 'sessions.json').length
    } catch { /* directory may not exist yet */ }
    return {
      dir,
      pending,
      allowSteer: cfg.allowSteer,
      consumed: stats.consumed,
      delivered: stats.delivered,
      rejected: stats.rejected,
      failed: stats.failed,
      last: stats.last,
    }
  }

  return { drain, refreshIndex, status, ensureDirs, dir }
}
