#!/usr/bin/env node
/**
 * Sender side of the dsh-plugin-codex-bridge relay.
 *
 * Drops one request file into the Host's inbox and (by default) waits for the
 * receipt, so a caller knows whether the owning Host actually accepted the
 * prompt. This process never touches a Session, a lock, or the DSH profile.
 *
 *   node tools/send.mjs --list
 *   node tools/send.mjs --session session-7502f96e-… --text "请修复 PR #10 的审查意见"
 *   node tools/send.mjs --session session-… --text "…" --mode queue --from codex
 *
 * Exit code: 0 delivered, 1 refused or failed, 2 usage/timeout.
 *
 * Request contract (see lib/inbox.js):
 *   { sessionId, text, mode?: 'queue' | 'steer' (default queue), id?, from? }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = args[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const dir = typeof flag('dir') === 'string' ? flag('dir') : join(home, 'inbox')
const timeoutMs = Number.parseInt(String(flag('timeout', '60')), 10) * 1000

if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'dsh-plugin-codex-bridge 投递端（只写文件，不碰会话、不碰锁、不碰 profile）',
    '',
    '  node tools/send.mjs --list',
    '      列出宿主发布的会话索引（● 正在跑 / ○ 空闲），用来挑 sessionId',
    '',
    '  node tools/send.mjs --session <sessionId> --text "<内容>" [选项]',
    '      --mode queue|steer   默认 queue：排队等当前轮次结束，不打断；steer 默认被宿主拒绝',
    '      --from <名字>        写进回执，便于溯源（例如 codex）',
    '      --id <字符串>        幂等键，默认自动生成',
    '      --timeout <秒>       等回执的超时，默认 60',
    '      --dir <目录>         投递箱位置，默认 $DSH_HOME/inbox（或 ~/.dsh/inbox）',
    '',
    '退出码：0 已投递 / 1 被拒或投递失败 / 2 用法错误或等不到回执',
  ].join('\n'))
  process.exit(0)
}

if (args.includes('--list')) {
  const index = join(dir, 'sessions.json')
  if (!existsSync(index)) {
    console.error(`没有会话索引：${index}\n（桌面宿主里的 dsh-plugin-codex-bridge 还没跑过一轮，或投递箱未启用）`)
    process.exit(2)
  }
  const value = JSON.parse(readFileSync(index, 'utf8'))
  console.log(`# ${value.count} 条会话，索引生成于 ${new Date(value.generatedAt).toLocaleString()}`)
  if (value.count === 0) {
    console.error('注意：索引里 0 条会话。若桌面应用刚启动，稍等几秒再试；若一直为空，说明宿主没能读到会话目录。')
    process.exit(2)
  }
  for (const item of value.items) {
    if (item.origin === 'subagent') continue
    console.log(`${item.running ? '●' : '○'} ${item.sessionId}\n    ${item.cwd ?? '(无目录)'}${item.blank ? '  [空会话]' : ''}`)
  }
  process.exit(0)
}

const sessionId = flag('session')
const text = flag('text')
if (typeof sessionId !== 'string' || typeof text !== 'string') {
  console.error('用法：node tools/send.mjs --session <sessionId> --text "<要投递的内容>" [--mode queue] [--from codex] [--timeout 60]')
  console.error('      node tools/send.mjs --list')
  process.exit(2)
}

const mode = flag('mode', 'queue')
const from = flag('from', 'cli')
const id = typeof flag('id') === 'string' ? flag('id') : `relay-${Date.now()}-${randomBytes(3).toString('hex')}`

mkdirSync(dir, { recursive: true, mode: 0o700 })
const requestPath = join(dir, `${id}.json`)
writeFileSync(requestPath, `${JSON.stringify({ id, sessionId, text, mode, from }, null, 2)}\n`, { mode: 0o600 })
console.log(`已投递请求 ${id} → ${requestPath}`)

const receiptPath = join(dir, 'receipts', `${id}.json`)
const deadline = Date.now() + timeoutMs
while (Date.now() < deadline) {
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    console.log(JSON.stringify(receipt, null, 2))
    if (receipt.ok === true) {
      if (receipt.queuedBehindRunningTurn === true) {
        console.log('说明：目标会话正在跑一轮，这条消息已排队，等本轮结束后才会被处理——没有打断它。')
      }
      process.exit(0)
    }
    process.exit(1)
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}

console.error(`等待 ${timeoutMs / 1000}s 没有等到回执：${receiptPath}`)
console.error('宿主里的插件可能未启用投递箱，或桌面应用没在运行。请求文件保留在收件箱。')
process.exit(2)
