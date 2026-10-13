#!/usr/bin/env python3
"""Mechanical behaviour of scripts/notify.py, verified entirely offline.

Nothing here touches the network, your real Codex CLI or your real DSH state:

* `git ls-remote` is served by a shim placed first on PATH;
* the Codex CLI is a stub that records every invocation;
* the ledger lives in a temporary directory.

    python3 tests/test_notify.py

Exits non-zero if any check fails.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NOTIFY = HERE.parent / 'scripts' / 'notify.py'
REAL_GIT = shutil.which('git')
BRANCH = 'feature/demo'
THREAD = '01a134e9-65ae-77e1-8946-dbe0c0c42123'
PR = 'https://github.com/heswy/demo/pull/7'

GIT_SHIM = '''#!/usr/bin/env python3
import os, sys
argv = sys.argv[1:]
if 'ls-remote' in argv:
    sys.stdout.write(os.environ.get('FAKE_LSREMOTE', '') + '\\n')
    raise SystemExit(0)
os.execv(os.environ['REAL_GIT'], [os.environ['REAL_GIT'], *argv])
'''

CODEX_STUB = '''#!/usr/bin/env python3
import os, sys, uuid
argv = sys.argv[1:]
with open(os.environ['CODEX_STUB_LOG'], 'a') as stream:
    stream.write(' '.join(argv) + '\\n')
if '--help' in argv:
    print('Queue a message for an existing session')
    print('Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>')
    raise SystemExit(0)
mode = os.environ.get('CODEX_STUB_MODE', 'ok')
if mode == 'garbage':
    print('queued it, probably')
    raise SystemExit(0)
if mode == 'fail':
    print('daemon unreachable', file=sys.stderr)
    raise SystemExit(3)
thread = argv[argv.index('--thread') + 1]
print('Queued message %s for thread %s' % (uuid.uuid4(), thread))
'''

# A CLI that exists but does not implement `queue` (no --thread in its usage).
WRONG_STUB = '''#!/usr/bin/env python3
import sys
print('Usage: codex exec [OPTIONS]')
'''

_results = []


def check(name, ok, detail=''):
    _results.append((name, bool(ok)))
    print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else f'   → {detail}'))


def section(title):
    print('\n' + title)


def write_exec(path: Path, text: str):
    path.write_text(text)
    path.chmod(0o755)


class Sandbox:
    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix='dsh2codex-test-'))
        self.bin = self.dir / 'bin'
        self.bad_bin = self.dir / 'bin-bad'
        self.bin.mkdir()
        self.bad_bin.mkdir()
        write_exec(self.bin / 'git', GIT_SHIM)
        write_exec(self.bin / 'codex', CODEX_STUB)
        write_exec(self.bad_bin / 'codex', WRONG_STUB)
        self.codex = self.bin / 'codex'
        self.log = self.dir / 'codex-calls.log'
        self.log.write_text('')
        self.ledger = self.dir / 'ledger'
        self.summary = self.dir / 'summary.md'
        self.summary.write_text('# 验证摘要\n\n- 单元测试 34 条通过\n- 未验证：真机网络\n')
        self.repo = self.dir / 'repo'
        self.repo.mkdir()
        self.git('init', '-q', '-b', BRANCH)
        self.git('config', 'user.email', 'dev@example.com')
        self.git('config', 'user.name', 'dev')
        (self.repo / 'README.md').write_text('demo\n')
        self.git('add', '-A')
        self.git('commit', '-qm', 'init')
        self.git('remote', 'add', 'origin', 'https://github.com/heswy/demo.git')
        self.head = self.git('rev-parse', 'HEAD')
        self.base_env = dict(os.environ)
        self.base_env.update({
            'PATH': str(self.bin) + os.pathsep + os.environ.get('PATH', ''),
            'REAL_GIT': REAL_GIT,
            'CODEX_STUB_LOG': str(self.log),
            'FAKE_LSREMOTE': '',
        })
        self.base_env.pop('DSH2CODEX_BIN', None)
        self.base_env.pop('CODEX_BIN', None)
        self.publish()

    # -- helpers ---------------------------------------------------------------
    def git(self, *argv):
        return subprocess.run([REAL_GIT, '-C', str(self.repo), *argv], check=True,
                              capture_output=True, text=True).stdout.strip()

    def publish(self, head=None, branch=None):
        self.base_env['FAKE_LSREMOTE'] = f'{head or self.head}\trefs/heads/{branch or BRANCH}'

    def run(self, *extra, env=None, argv=None):
        merged = dict(self.base_env)
        merged.update(env or {})
        full = argv if argv is not None else [
            sys.executable, str(NOTIFY), '--thread', THREAD, '--repo', str(self.repo),
            '--branch', BRANCH, '--pr-url', PR, '--summary-file', str(self.summary),
            '--ledger-dir', str(self.ledger), *extra]
        return subprocess.run(full, capture_output=True, text=True, env=merged, timeout=60)

    def sends(self):
        return [line for line in self.log.read_text().splitlines() if '--message' in line]

    def ledger_data(self):
        path = self.ledger / 'ledger.json'
        return json.loads(path.read_text()) if path.exists() else {}

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def main():
    if REAL_GIT is None:
        print('需要 git 才能运行本测试', file=sys.stderr)
        return 1

    # -- probe / dry-run -------------------------------------------------------
    section('探测与预演（不发通知）')
    box = Sandbox()
    try:
        result = box.run(argv=[sys.executable, str(NOTIFY), '--probe'])
        probe = json.loads(result.stdout) if result.returncode == 0 else {}
        check('--probe 不需要其他参数即可运行', result.returncode == 0, result.stderr.strip())
        check('--probe 经 PATH 找到 Codex CLI', probe.get('cli') == str(box.codex), probe)
        check('--probe 报告 queue 支持', probe.get('supportsQueue') is True, probe)
        check('--probe 列出尝试过的候选', any(c.get('source') == 'PATH' for c in probe.get('candidates', [])), probe)

        result = box.run('--dry-run')
        check('--dry-run 退出 0 且状态为 dry-run',
              result.returncode == 0 and json.loads(result.stdout)['status'] == 'dry-run', result.stderr.strip())
        check('--dry-run 不写账本', not (box.ledger / 'ledger.json').exists())
        check('--dry-run 不调用 CLI', box.sends() == [], box.log.read_text())

        # -- happy path + idempotence -----------------------------------------
        section('投递与幂等')
        result = box.run()
        payload = json.loads(result.stdout) if result.returncode == 0 else {}
        check('首次投递：退出 0，状态 queued',
              result.returncode == 0 and payload.get('status') == 'queued', result.stdout + result.stderr)
        check('首次投递：CLI 被调用一次', len(box.sends()) == 1, box.log.read_text())
        record = box.ledger_data().get(payload.get('eventId'), {})
        check('账本记录 queued + messageId',
              record.get('state') == 'queued' and record.get('messageId'), record)
        check('账本记录实际使用的 CLI', record.get('cli') == str(box.codex), record)

        result = box.run()
        check('同一 head 重发：already-queued 且退出 0',
              result.returncode == 0 and json.loads(result.stdout)['status'] == 'already-queued', result.stdout)
        check('同一 head 重发：CLI 没有被再调用', len(box.sends()) == 1, box.log.read_text())

        (box.repo / 'feature.txt').write_text('work\n')
        box.git('add', '-A')
        box.git('commit', '-qm', 'feat: work')
        box.head = box.git('rev-parse', 'HEAD')
        box.publish()
        result = box.run()
        check('新 head 可以再次交回',
              result.returncode == 0 and json.loads(result.stdout)['status'] == 'queued', result.stdout)
        check('新 head 是新事件（账本两条）', len(box.ledger_data()) == 2, list(box.ledger_data()))

        # -- 前置校验 ----------------------------------------------------------
        section('前置校验（都在发通知之前拦下）')
        (box.repo / 'feature.txt').write_text('uncommitted\n')
        result = box.run()
        check('脏工作区：退出 1 且提示提交', result.returncode == 1 and '未提交修改' in result.stderr, result.stderr.strip())
        box.git('checkout', '--', 'feature.txt')

        result = box.run('--branch', 'feature/other')
        check('分支不一致：退出 1', result.returncode == 1 and '分支' in result.stderr, result.stderr.strip())

        stale = box.head
        box.publish(head='0' * 40)
        result = box.run()
        check('head 未推送：退出 1', result.returncode == 1 and '尚未在远端' in result.stderr, result.stderr.strip())
        box.publish(head=stale)

        box.git('remote', 'set-url', 'origin', 'https://github.com/other/repo.git')
        result = box.run()
        check('origin 与 PR 不同仓：退出 1', result.returncode == 1 and '不一致' in result.stderr, result.stderr.strip())
        box.git('remote', 'set-url', 'origin', 'https://github.com/heswy/demo.git')

        result = box.run('--pr-url', 'https://gitlab.com/heswy/demo/pull/7')
        check('非 GitHub PR URL：退出 1', result.returncode == 1, result.stderr.strip())

        result = box.run('--thread', 'not-a-uuid')
        check('thread 不是 UUID：退出 1', result.returncode == 1, result.stderr.strip())

        big = box.dir / 'big.md'
        big.write_text('x' * 16001)
        result = box.run('--summary-file', str(big))
        check('摘要超长：退出 1', result.returncode == 1 and '16000' in result.stderr, result.stderr.strip())

        result = box.run()
        check('校验失败都没有惊动 CLI', len(box.sends()) == 2, box.log.read_text())

        # -- 结果不可确认 ------------------------------------------------------
        section('结果不可确认时停下，不重发')
        box.env_garbage = {'CODEX_STUB_MODE': 'garbage'}
        box.git('commit', '-q', '--allow-empty', '-m', 'empty')
        box.head = box.git('rev-parse', 'HEAD')
        box.publish()
        result = box.run(env=box.env_garbage)
        check('stdout 不认识：退出 2，状态 unknown',
              result.returncode == 2 and json.loads(result.stdout)['status'] == 'unknown', result.stdout + result.stderr)
        record = list(box.ledger_data().values())[-1]
        check('unknown 也写进账本（避免无脑重发）', record.get('state') == 'unknown', record)
        before = len(box.sends())
        result = box.run(env=box.env_garbage)
        check('unknown 之后重跑：blocked 且退出 2',
              result.returncode == 2 and json.loads(result.stdout)['status'] == 'blocked', result.stdout)
        check('unknown 之后没有再发一次', len(box.sends()) == before, box.log.read_text())

        box.git('commit', '-q', '--allow-empty', '-m', 'empty2')
        box.head = box.git('rev-parse', 'HEAD')
        box.publish()
        result = box.run(env={'CODEX_STUB_MODE': 'fail'})
        check('CLI 非零退出：退出 2，状态 unknown',
              result.returncode == 2 and json.loads(result.stdout)['status'] == 'unknown', result.stdout)

        # -- CLI 选择 ----------------------------------------------------------
        section('Codex CLI 选择：宁可失败，也不用错的那个')
        box.git('commit', '-q', '--allow-empty', '-m', 'empty3')
        box.head = box.git('rev-parse', 'HEAD')
        box.publish()
        result = box.run(env={'PATH': str(box.bad_bin) + os.pathsep + box.base_env['PATH']})
        check('PATH 上第一个 codex 不支持 queue 时会继续找下一个',
              result.returncode == 0 and json.loads(result.stdout)['status'] == 'queued', result.stdout + result.stderr)

        box.git('commit', '-q', '--allow-empty', '-m', 'empty4')
        box.head = box.git('rev-parse', 'HEAD')
        box.publish()
        result = box.run('--codex-bin', str(box.bad_bin / 'codex'))
        check('显式指定不支持的 CLI：退出 1，不静默回退',
              result.returncode == 1 and '找不到可用的 Codex CLI' in result.stderr, result.stderr.strip())

        result = box.run('--codex-bin', str(box.dir / 'nope'))
        check('显式指定不存在的路径：退出 1 且报告尝试记录',
              result.returncode == 1 and '尝试过' in result.stderr and 'nope' in result.stderr,
              result.stderr.strip())
    finally:
        box.cleanup()

    passed = sum(1 for _name, ok in _results if ok)
    failed = len(_results) - passed
    print(f'\n{passed} passed, {failed} failed')
    if failed:
        for name, ok in _results:
            if not ok:
                print('  FAILED: ' + name)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
