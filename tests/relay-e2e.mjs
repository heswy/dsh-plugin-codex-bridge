/**
 * End-to-end relay check: the real sender CLI against the real inbox module.
 *
 * Simulates what the desktop Host does (drain on a timer) with a mock Session
 * controller, and asserts the caller's exit code and the receipt it reads back.
 *
 * Run: node tests/relay-e2e.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInbox, readInboxConfig } from '../lib/inbox.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const sender = join(here, '..', 'tools', 'send.mjs')

const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [sender, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('close', (code) => resolve({ code, stdout, stderr }))
})

/** The receipt is the first JSON object in stdout; a note may follow it. */
const parseReceipt = (stdout) => JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1))

const root = mkdtempSync(join(tmpdir(), 'wsync-relay-'))
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

/** An inbox with a mock owner, draining on the same cadence the Host uses. */
const owner = (dir, { promptImpl } = {}) => {
  const calls = []
  const ctx = {
    get: (key) => (key === 'sessionController'
      ? {
        prompt: async (request) => {
          calls.push(request)
          return promptImpl === undefined ? { accepted: true } : promptImpl(request)
        },
        list: async () => ({
          items: [
            { sessionId: 'session-7502f96e-6e67-42dd-9994-ef3d51b4b326', cwd: '/Users/orange/x', running: true, updatedAt: 1 },
            { sessionId: 'session-other', cwd: '/tmp/y', running: false, blank: false, updatedAt: 2 },
          ],
        }),
      }
      : undefined),
  }
  const { cfg } = readInboxConfig({ dir, intervalMs: 200 })
  const inbox = createInbox({ ctx, cfg, log: () => {} })
  void inbox.refreshIndex(true)
  const timer = setInterval(() => { void inbox.drain('test') }, 100)
  return { calls, stop: () => clearInterval(timer) }
}

try {
  await test('--list prints the index the owning Host publishes', async () => {
    const dir = join(root, 'list')
    const { stop } = owner(dir)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const result = await run(['--dir', dir, '--list'])
    stop()
    assert.equal(result.code, 0)
    assert.match(result.stdout, /session-7502f96e-6e67-42dd-9994-ef3d51b4b326/)
    assert.match(result.stdout, /●/, 'a running session carries its marker')
  })

  await test('a delivered request exits 0 and reports the queued-behind-turn note', async () => {
    const dir = join(root, 'deliver')
    const { calls, stop } = owner(dir)
    const result = await run([
      '--dir', dir,
      '--session', 'session-7502f96e-6e67-42dd-9994-ef3d51b4b326',
      '--text', '请修复 PR #10 的审查意见，并在原分支补回归',
      '--from', 'e2e',
      '--timeout', '15',
    ])
    stop()
    assert.equal(result.code, 0, result.stderr)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].mode, 'queue')
    assert.deepEqual(calls[0].content, [{ type: 'text', text: '请修复 PR #10 的审查意见，并在原分支补回归' }])
    const receipt = parseReceipt(result.stdout)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.from, 'e2e')
    assert.equal(receipt.targetRunning, true)
    assert.equal(receipt.queuedBehindRunningTurn, true)
    assert.match(result.stdout, /没有打断它/)
  })

  await test('a refused steer exits 1 and never reaches the Session', async () => {
    const dir = join(root, 'steer')
    const { calls, stop } = owner(dir)
    const result = await run([
      '--dir', dir, '--session', 'session-other', '--text', '插一句', '--mode', 'steer', '--timeout', '15',
    ])
    stop()
    assert.equal(result.code, 1)
    assert.equal(calls.length, 0)
    assert.match(result.stdout, /steer-disabled/)
  })

  await test('a failing delivery exits 1 with the host error code', async () => {
    const dir = join(root, 'fail')
    const { stop } = owner(dir, {
      promptImpl: () => {
        const error = new Error('session is held by another writer')
        error.code = 'session/writer-held'
        throw error
      },
    })
    const result = await run(['--dir', dir, '--session', 'session-other', '--text', 'x', '--timeout', '15'])
    stop()
    assert.equal(result.code, 1)
    const receipt = parseReceipt(result.stdout)
    assert.equal(receipt.reason, 'delivery-failed')
    assert.equal(receipt.code, 'session/writer-held')
  })

  await test('no owner listening means a clean timeout, request kept', async () => {
    const dir = join(root, 'nobody')
    const result = await run(['--dir', dir, '--session', 'session-other', '--text', 'x', '--timeout', '1'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /没有等到回执/)
    assert.ok(
      readdirSync(dir).some((name) => name.startsWith('relay-') && name.endsWith('.json')),
      'the request file stays in the inbox when nobody consumes it',
    )
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
