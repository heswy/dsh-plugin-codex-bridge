#!/usr/bin/env python3
"""Validate a pushed GitHub handoff and queue it to the supervisor Codex thread exactly once.

Contract (see ../SKILL.md):

* every check is read-only git (`check-ref-format`, `branch --show-current`,
  `status --porcelain`, `remote get-url`, `rev-parse`, `ls-remote`); this script never
  commits, pushes, creates a PR or changes Git state;
* the event id is deterministic over (repo slug, PR number, head, thread), and a ledger
  makes the same handoff impossible to queue twice — including after a crash;
* the outcome is always reported as one of `queued` / `already-queued` / `blocked` /
  `unknown`, and anything unconfirmed stops instead of retrying.

The Codex CLI is discovered rather than hard-coded, because pointing at the *wrong*
binary is worse than pointing at none: the wrong one may queue into a different
app-server daemon and report success. Every candidate is therefore probed for a real
`queue --thread --message` subcommand before it is used.

Exit codes: 0 confirmed (`queued`, `already-queued`), 1 validation/usage error,
2 outcome not confirmed (`unknown`, `blocked`).
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

PR_URL = re.compile(r'https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)/?')
ORIGIN_URL = re.compile(r'(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+)')
QUEUED_LINE = re.compile(r'Queued message ([0-9a-fA-F-]{36}) for thread ([0-9a-fA-F-]{36})')

REQUIRED_FLAGS = ('thread', 'repo', 'branch', 'pr-url', 'summary-file')
MAX_SUMMARY_BYTES = 16000
QUEUE_TIMEOUT_SECONDS = 45
PROBE_TIMEOUT_SECONDS = 5
DEFAULT_LEDGER_DIR = '~/.dsh/codex-notifications'

# Where the app-bundled CLI lives on a normal macOS install. Not a hard requirement:
# it is one candidate among several, and `--codex-bin` / `CODEX_BIN` win over all of them.
CHATGPT_APP_CLI = 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'


# --------------------------------------------------------------------------- CLI discovery

def cli_candidates(explicit: str | None):
    """Ordered (source, path) candidates. An explicit path is the only candidate."""
    if explicit:
        return [('--codex-bin', explicit)]
    candidates = []
    for name in ('DSH2CODEX_BIN', 'CODEX_BIN'):
        value = os.environ.get(name)
        if value:
            candidates.append((name, value))
    on_path = shutil.which('codex')
    if on_path:
        candidates.append(('PATH', on_path))
    for label, base in (('/Applications', '/Applications/ChatGPT.app'),
                        ('~/Applications', str(Path.home() / 'Applications/ChatGPT.app'))):
        candidates.append((label, str(Path(base) / CHATGPT_APP_CLI)))
    return candidates


def supports_queue(path: str, timeout: int = PROBE_TIMEOUT_SECONDS):
    """(ok, detail): is `path` an executable Codex CLI that exposes `queue`?"""
    if not Path(path).is_file():
        return False, 'not a file'
    if not os.access(path, os.X_OK):
        return False, 'not executable'
    try:
        result = subprocess.run([path, 'queue', '--help'], capture_output=True,
                                text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, f'`queue --help` timed out after {timeout}s'
    except OSError as exc:
        return False, str(exc)
    if result.returncode != 0:
        return False, f'`queue --help` exited {result.returncode}'
    text = (result.stdout or '') + (result.stderr or '')
    if '--thread' not in text or '--message' not in text:
        return False, 'no `queue --thread --message` subcommand'
    return True, 'ok'


def resolve_cli(explicit: str | None = None):
    """First candidate that answers `queue --help`; raises with the full trail otherwise."""
    tried = []
    for source, path in cli_candidates(explicit):
        ok, detail = supports_queue(path)
        tried.append({'source': source, 'path': path, 'ok': ok, 'detail': detail})
        if ok:
            return path, tried
        if explicit:
            break  # never silently replace what the caller asked for
    raise ValueError('找不到可用的 Codex CLI（需要支持 `queue --thread --message`）；尝试过：'
                     + json.dumps(tried, ensure_ascii=False))


def cli_version(path: str):
    try:
        result = subprocess.run([path, '--version'], capture_output=True, text=True,
                                timeout=PROBE_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return None
    text = ((result.stdout or '') + (result.stderr or '')).strip()
    return text.splitlines()[0] if text else None


# --------------------------------------------------------------------------- ledger

def save(path: Path, value):
    """Atomic, fsync'd write: a crash must not leave a half-written ledger."""
    tmp = path.with_name(path.name + '.tmp-' + str(uuid.uuid4()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


@contextmanager
def ledger_lock(path: Path):
    """Exclusive lock across processes: fcntl on POSIX, msvcrt on Windows."""
    handle = open(path, 'a+')
    try:
        try:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
        except ImportError:  # Windows
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        yield handle
    finally:
        handle.close()


# --------------------------------------------------------------------------- validation

def validate(args) -> dict:
    """Read-only validation of the real Git state. Returns the facts the message needs."""
    uuid.UUID(args.thread)
    match = PR_URL.fullmatch(args.pr_url)
    if not match:
        raise ValueError('需要明确的 GitHub PR URL，例如 https://github.com/owner/repo/pull/123')
    slug = '/'.join(match.group(1, 2))
    pr_number = match.group(3)

    repo = Path(args.repo).resolve(strict=True)

    def git(*argv):
        return subprocess.run(['git', '-C', str(repo), *argv], check=True,
                              capture_output=True, text=True, timeout=30).stdout.strip()

    git('check-ref-format', 'refs/heads/' + args.branch)
    if git('branch', '--show-current') != args.branch:
        raise ValueError('当前分支与任务分支不一致')
    if git('status', '--porcelain'):
        raise ValueError('工作区有未提交修改，请完成并提交后交回')
    remote = git('remote', 'get-url', '--push', 'origin')
    origin = ORIGIN_URL.fullmatch(remote)
    if not origin or origin[1].removesuffix('.git').lower() != slug.lower():
        raise ValueError('origin push 仓库与 PR 仓库不一致')
    head = git('rev-parse', 'HEAD')
    ref = 'refs/heads/' + args.branch
    rows = git('ls-remote', '--heads', remote, ref).splitlines()
    if not any(row.split() == [head, ref] for row in rows):
        raise ValueError('当前完整 head 尚未在远端任务分支，请先完成 push')

    summary = Path(args.summary_file).read_text(encoding='utf-8').strip()
    if not summary:
        raise ValueError('验证摘要不能为空')
    if len(summary.encode('utf-8')) > MAX_SUMMARY_BYTES:
        raise ValueError(f'验证摘要超过 {MAX_SUMMARY_BYTES} UTF-8 字节')

    key = '|'.join([slug.lower(), pr_number, head, args.thread])
    event_id = 'dsh-review-' + hashlib.sha256(key.encode()).hexdigest()[:24]
    message = (f'DSH 开发交回，请 review。\n通知 ID：{event_id}\n'
               f'原工作区：{repo}\n分支：{args.branch}\nPR：{args.pr_url}\nHead：{head}\n'
               f'验证与限制：\n{summary}\n\n'
               '这是本任务用户已授权的交回通知，不扩展原授权。请核对PR远端head和分支交回状态，'
               '再独立review。相同通知ID/head不要重复审查；发现确定问题按已有授权告知原DSH开发会话修复。'
               '未授权合码或发布。开发方发通知后将交回分支、等待审查。')
    return {'repo': str(repo), 'head': head, 'event_id': event_id, 'message': message}


# --------------------------------------------------------------------------- entry point

def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    for flag in REQUIRED_FLAGS:
        parser.add_argument('--' + flag, help='（--probe 之外必填）')
    parser.add_argument('--dry-run', action='store_true',
                        help='只打印将要发送的正文，不投递、不写账本')
    parser.add_argument('--probe', action='store_true',
                        help='只报告会使用哪个 Codex CLI 及其版本，不发通知')
    parser.add_argument('--codex-bin', default=None,
                        help='显式指定 Codex CLI（默认自动探测）')
    parser.add_argument('--ledger-dir', default=DEFAULT_LEDGER_DIR,
                        help=f'账本目录，默认 {DEFAULT_LEDGER_DIR}')
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.probe:
        cli, tried = resolve_cli(args.codex_bin)
        print(json.dumps({'status': 'probe', 'cli': cli, 'version': cli_version(cli),
                          'supportsQueue': True, 'candidates': tried,
                          'ledgerDir': str(Path(args.ledger_dir).expanduser())},
                         ensure_ascii=False, indent=2))
        return 0

    missing = [flag for flag in REQUIRED_FLAGS if not getattr(args, flag.replace('-', '_'))]
    if missing:
        raise ValueError('缺少必填参数：' + ', '.join('--' + flag for flag in missing))

    facts = validate(args)
    if args.dry_run:
        print(json.dumps({'status': 'dry-run', 'eventId': facts['event_id'],
                          'thread': args.thread, 'head': facts['head'],
                          'message': facts['message']}, ensure_ascii=False, indent=2))
        return 0

    directory = Path(args.ledger_dir).expanduser()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    ledger_path = directory / 'ledger.json'
    with ledger_lock(directory / 'ledger.lock'):
        ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
        previous = ledger.get(facts['event_id'])
        if previous:
            state = 'already-queued' if previous.get('state') == 'queued' else 'blocked'
            print(json.dumps({'status': state, 'eventId': facts['event_id'], 'record': previous},
                             ensure_ascii=False))
            return 0 if state == 'already-queued' else 2

        cli, _tried = resolve_cli(args.codex_bin)
        record = {'state': 'sending', 'thread': args.thread, 'pr': args.pr_url,
                  'head': facts['head'], 'cli': cli, 'at': time.time()}
        ledger[facts['event_id']] = record
        save(ledger_path, ledger)
        try:
            result = subprocess.run([cli, 'queue', '--thread', args.thread,
                                     '--message', facts['message']],
                                    capture_output=True, text=True, timeout=QUEUE_TIMEOUT_SECONDS)
            accepted = QUEUED_LINE.search(result.stdout or '')
            if result.returncode == 0 and accepted and accepted[2].lower() == args.thread.lower():
                record.update(state='queued', messageId=accepted[1])
            else:
                record.update(state='unknown', exitCode=result.returncode)
        except (subprocess.TimeoutExpired, OSError):
            record.update(state='unknown')
        save(ledger_path, ledger)
        print(json.dumps({'status': record['state'], 'eventId': facts['event_id'],
                          'record': record}, ensure_ascii=False))
        return 0 if record['state'] == 'queued' else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        print('通知未确认；停止自动重发：' + str(exc), file=sys.stderr)
        sys.exit(1)
