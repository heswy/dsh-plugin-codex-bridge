/**
 * Inbox (relay) harness for dsh-plugin-codex-bridge.
 *
 * Exercises the real `lib/inbox.js` against a mock Session controller and real
 * temporary directories: claim/consume/receipt behaviour, the steer refusal, and
 * every rejection path. Nothing here touches a live Session.
 *
 * Run: node tests/inbox.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInbox, readInboxConfig } from '../lib/inbox.js'

let passed = 0
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

const root = mkdtempSync(join(tmpdir(), 'wsync-inbox-'))
let caseIndex = 0

/** Fresh inbox dir + mock controller for one case. */
const setup = ({ config = {}, sessions = [], promptImpl = null } = {}) => {
  const dir = join(root, `case-${caseIndex += 1}`)
  mkdirSync(dir, { recursive: true })
  const calls = []
  const controller = {
    prompt: async (request, signal) => {
      // The real service's Remote wrapper opens with `signal.throwIfAborted()`,
      // so a missing signal fails before the Session is touched at all. Mirror
      // that here: the bug this guards against shipped once already.
      if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      calls.push({ request, signal })
      if (promptImpl !== null) return promptImpl(request, calls.length)
      return { accepted: true }
    },
    list: async () => ({ items: sessions }),
  }
  const logs = []
  const ctx = { get: (key) => (key === 'sessionController' ? controller : undefined) }
  const { cfg } = readInboxConfig({ dir, intervalMs: 1000, ...config })
  const inbox = createInbox({ ctx, cfg, log: (level, message) => logs.push({ level, message }) })
  return { dir, inbox, calls, logs }
}

const drop = (dir, name, value) => {
  const path = join(dir, name)
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  return path
}

const receipt = (dir, id) => JSON.parse(readFileSync(join(dir, 'receipts', `${id}.json`), 'utf8'))

try {
  await test('delivers a queued prompt with the exact request shape and writes a receipt', async () => {
    const { dir, inbox, calls } = setup()
    drop(dir, 'req-1.json', { sessionId: 'session-7502f96e-6e67-42dd-9994-ef3d51b4b326', text: '请修复 PR #10 的审查意见', from: 'codex' })
    const results = await inbox.drain('test')

    assert.equal(results.length, 1)
    assert.equal(calls.length, 1)
    const sent = calls[0].request
    assert.equal(sent.requestId, 'req-1')
    assert.equal(sent.sessionId, 'session-7502f96e-6e67-42dd-9994-ef3d51b4b326')
    assert.equal(sent.mode, 'queue')
    assert.deepEqual(sent.content, [{ type: 'text', text: '请修复 PR #10 的审查意见' }])

    const r = receipt(dir, 'req-1')
    assert.equal(r.ok, true)
    assert.equal(r.accepted, true)
    assert.equal(r.mode, 'queue')
    assert.equal(r.from, 'codex')

    // request consumed, no claim left behind
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'sessions.json'), [])
  })

  await test('a running target is queued behind its current turn, never interrupted', async () => {
    const { dir, inbox, calls } = setup({
      sessions: [{ sessionId: 'session-target', running: true, cwd: '/tmp/x', updatedAt: 1 }],
    })
    drop(dir, 'req-2.json', { sessionId: 'session-target', text: '第二轮修复' })
    await inbox.drain('test')

    assert.equal(calls.length, 1)
    assert.equal(calls[0].request.mode, 'queue', 'queue is the only non-disruptive mode')
    const r = receipt(dir, 'req-2')
    assert.equal(r.ok, true)
    assert.equal(r.targetRunning, true)
    assert.equal(r.queuedBehindRunningTurn, true)
  })

  await test('steer is refused unless explicitly enabled', async () => {
    const { dir, inbox, calls } = setup()
    drop(dir, 'req-3.json', { sessionId: 'session-target', text: '插一句', mode: 'steer' })
    await inbox.drain('test')

    assert.equal(calls.length, 0, 'a refused steer must never reach the Session')
    const r = receipt(dir, 'req-3')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'steer-disabled')
    assert.ok(existsSync(join(dir, 'rejected', 'req-3.json')), 'refused request is kept aside')
  })

  await test('steer is delivered when the owner opted in', async () => {
    const { dir, inbox, calls } = setup({ config: { allowSteer: true } })
    drop(dir, 'req-4.json', { sessionId: 'session-target', text: '插一句', mode: 'steer' })
    await inbox.drain('test')

    assert.equal(calls.length, 1)
    assert.equal(calls[0].request.mode, 'steer')
    assert.equal(receipt(dir, 'req-4').ok, true)
  })

  await test('rejects malformed and invalid requests without calling the Session', async () => {
    const { dir, inbox, calls } = setup()
    drop(dir, 'bad-json.json', '{ not json')
    drop(dir, 'bad-id.json', { sessionId: '../../etc/passwd', text: 'x' })
    drop(dir, 'no-text.json', { sessionId: 'session-ok' })
    drop(dir, 'blank.json', { sessionId: 'session-ok', text: '   ' })
    drop(dir, 'bad-mode.json', { sessionId: 'session-ok', text: 'x', mode: 'interrupt' })
    await inbox.drain('test')

    assert.equal(calls.length, 0)
    assert.equal(receipt(dir, 'bad-json').reason, 'unreadable-request')
    assert.equal(receipt(dir, 'bad-id').reason, 'bad-session-id')
    assert.equal(receipt(dir, 'no-text').reason, 'empty-text')
    assert.equal(receipt(dir, 'blank').reason, 'empty-text')
    assert.equal(receipt(dir, 'bad-mode').reason, 'bad-mode')
    assert.equal(readdirSync(join(dir, 'rejected')).filter((n) => n.endsWith('.json')).length, 5)
  })

  await test('a delivery failure is recorded with its code and never retried', async () => {
    const { dir, inbox, calls } = setup({
      promptImpl: () => {
        const error = new Error('session is held by another writer')
        error.code = 'session/writer-held'
        throw error
      },
    })
    drop(dir, 'req-5.json', { sessionId: 'session-target', text: 'x' })
    await inbox.drain('test')
    await inbox.drain('test')

    assert.equal(calls.length, 1, 'a consumed request is not retried on the next pass')
    const r = receipt(dir, 'req-5')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'delivery-failed')
    assert.equal(r.code, 'session/writer-held')
  })

  await test('a hung delivery times out and does not block the relay', async () => {
    const { dir, inbox, calls } = setup({
      config: { deliveryTimeoutMs: 1000 },
      promptImpl: (request, n) => (n === 1 ? new Promise(() => {}) : { accepted: true }),
    })
    // The deadline timer is `unref()`d on purpose (it must not hold a real app
    // open). In a test process that also lets Node decide the loop is idle and
    // exit on the unsettled top-level await, so keep the loop alive here.
    const keepAlive = setInterval(() => {}, 50)
    try {
      drop(dir, 'hang-1.json', { sessionId: 'session-target', text: '会卡住的这条' })
      const first = await inbox.drain('test')
      assert.equal(first[0].reason, 'delivery-timeout')
      assert.match(first[0].message, /delivery timeout/)

      drop(dir, 'ok-2.json', { sessionId: 'session-target', text: '下一条' })
      const second = await inbox.drain('test')
      assert.equal(second[0].ok, true, 'the single in-flight slot is released again')
      assert.equal(calls.length, 2)
    } finally {
      clearInterval(keepAlive)
    }
  })

  await test('a claimed file is invisible, and concurrent drains share one pass', async () => {
    const { dir, inbox, calls } = setup()
    writeFileSync(join(dir, 'inflight.json.claim'), JSON.stringify({ sessionId: 'session-x', text: 'x' }))
    drop(dir, 'req-6.json', { sessionId: 'session-target', text: '一次' })

    const first = inbox.drain('test')
    const second = inbox.drain('test')
    await Promise.all([first, second])

    assert.equal(calls.length, 1, 'the same pass must not deliver twice')
    assert.ok(existsSync(join(dir, 'inflight.json.claim')), 'a foreign claim is left alone')
  })

  await test('refreshIndex publishes the deliverable session list', async () => {
    const { dir, inbox } = setup({
      sessions: [
        { sessionId: 'session-a', cwd: '/tmp/a', running: false, blank: false, updatedAt: 111 },
        { sessionId: 'session-b', cwd: '/tmp/b', running: true, blank: true, updatedAt: 222 },
      ],
    })
    await inbox.refreshIndex(true)
    const index = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
    assert.equal(index.count, 2)
    assert.deepEqual(index.items.map((item) => item.sessionId), ['session-a', 'session-b'])
    assert.equal(index.items[1].running, true)
  })

  await test('status counts what happened and what is pending', async () => {
    const { dir, inbox } = setup()
    drop(dir, 'req-7.json', { sessionId: 'session-target', text: 'ok' })
    drop(dir, 'req-8.json', { sessionId: 'session-target', text: 'x', mode: 'steer' })
    assert.equal(inbox.status().pending, 2)
    await inbox.drain('test')
    const status = inbox.status()
    assert.equal(status.delivered, 1)
    assert.equal(status.rejected, 1)
    assert.equal(status.pending, 0)
    // `last` is the most recently consumed request; req-8 (the refused steer) sorts last.
    assert.equal(status.last.ok, false)
    assert.equal(status.last.reason, 'steer-disabled')

    drop(dir, 'later.json', { sessionId: 'session-target', text: 'later' })
    assert.equal(inbox.status().pending, 1, 'a file dropped after the pass is pending again')
  })

  await test('publishes no index while the controller is unavailable', async () => {
    const dir = join(root, `case-${caseIndex += 1}`)
    mkdirSync(dir, { recursive: true })
    const { cfg } = readInboxConfig({ dir })
    const cold = createInbox({ ctx: { get: () => undefined }, cfg, log: () => {} })
    await cold.refreshIndex(true)
    assert.ok(!existsSync(join(dir, 'sessions.json')), 'an empty index would read as "there are no sessions"')

    const ready = createInbox({
      ctx: { get: (key) => (key === 'sessionController' ? { list: () => ({ items: [] }) } : undefined) },
      cfg,
      log: () => {},
    })
    await ready.refreshIndex(true)
    const index = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
    assert.equal(index.count, 0)
    assert.deepEqual(index.sources, { sessionController: 0 }, 'the index names where its numbers came from')
  })

  await test('config parsing is defensive and reports ignored keys', () => {
    const { cfg, warnings } = readInboxConfig({ intervalMs: 10, allowSteer: 'yes', nope: 1 })
    assert.equal(cfg.intervalMs, 200, 'below the floor is clamped')
    assert.equal(cfg.allowSteer, false, 'a non-boolean is ignored')
    assert.ok(warnings.some((warning) => warning.includes('nope')))
    assert.equal(readInboxConfig(undefined).cfg.enabled, true)
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
