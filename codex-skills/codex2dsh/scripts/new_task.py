#!/usr/bin/env python3
"""Register a DSH workspace, create/name one session, and queue one authorized task."""
import argparse
import fcntl
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import uuid


def save(path, value):
    fd, tmp = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['auth-url-file', 'workspace', 'title', 'text-file', 'supervisor-thread', 'request-id', 'state-file']:
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--branch', help='Expected Git branch, checked read-only before every run')
    args = parser.parse_args()
    uuid.UUID(args.supervisor_thread)
    workspace = Path(args.workspace).resolve(strict=True)
    if not workspace.is_dir() or not args.title.strip() or not args.request_id.strip():
        raise ValueError('Workspace must exist; title and request-id must be nonempty')
    if args.branch:
        actual = subprocess.run(['git', '-C', str(workspace), 'branch', '--show-current'], check=True,
                                capture_output=True, text=True).stdout.strip()
        if actual != args.branch:
            raise ValueError('Workspace branch does not match authorized task')
    text = Path(args.text_file).read_text(encoding='utf-8').strip()
    if not text:
        raise ValueError('Task text is empty')
    text = (f'发送方：主管 Codex。当前任务主管 thread UUID：{args.supervisor_thread}。\n'
            f'本任务回信目标为此 UUID；使用已安装的 dsh2codex 时显式传入 --thread {args.supervisor_thread}，'
            '不从历史/账本/DSH环境推断目标。通知前先dry-run核对目标。\n\n' + text)
    if len(text.encode('utf-8')) > 200000:
        raise ValueError('Task text exceeds 200000 UTF-8 bytes')
    identity = {'workspace': str(workspace), 'title': args.title, 'supervisorThread': args.supervisor_thread,
                'requestId': args.request_id, 'branch': args.branch,
                'textHash': hashlib.sha256(text.encode()).hexdigest()}
    state_path = Path(args.state_file).expanduser().resolve()
    state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(str(state_path) + '.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(state_path.read_text()) if state_path.exists() else {'identity': identity, 'phase': 'new'}
        if state['identity'] != identity:
            raise ValueError('State belongs to different task; do not reuse it')
        if state['phase'].endswith('_pending') or state['phase'] in ['unknown', 'rejected']:
            print(json.dumps({'status': 'blocked', 'state': state}, ensure_ascii=False))
            return 2
        if state['phase'] == 'accepted':
            print(json.dumps({'status': 'already-accepted', 'state': state}, ensure_ascii=False))
            return 0
        url = Path(args.auth_url_file).read_text().strip()
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.username or parsed.password:
            raise ValueError('Use the normal authentication URL printed by your loopback DSH host')
        origin = f'http://127.0.0.1:{parsed.port}'
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        opener.open(url, timeout=15).close()

        def rpc(method, payload):
            body = {'type': 'client-request', 'rpcId': str(uuid.uuid4()), 'method': method, 'payload': {'args': payload}}
            req = urllib.request.Request(origin + '/api/' + method, data=json.dumps(body).encode(),
                                         headers={'Content-Type': 'application/json', 'Origin': origin})
            return json.load(opener.open(req, timeout=30))['result']

        def mutate(method, payload, pending, done, consume):
            state['phase'] = pending
            save(state_path, state)
            try:
                result = rpc(method, payload)
            except Exception as exc:
                state.update(phase='unknown', lastMethod=method, errorType=type(exc).__name__)
                save(state_path, state)
                print(json.dumps({'status': 'unknown', 'state': state}, ensure_ascii=False))
                return False
            if not result.get('ok'):
                error = result.get('error', {})
                state.update(phase='rejected', lastMethod=method, errorCode=error.get('code', 'unknown'))
                save(state_path, state)
                print(json.dumps({'status': 'rejected', 'state': state}, ensure_ascii=False))
                return False
            try:
                consume(result['value'])
            except (KeyError, TypeError, ValueError):
                state.update(phase='unknown', lastMethod=method, errorType='UnexpectedResponse')
                save(state_path, state)
                print(json.dumps({'status': 'unknown', 'state': state}, ensure_ascii=False))
                return False
            state['phase'] = done
            save(state_path, state)
            return True

        if state['phase'] == 'new':
            def registered(value):
                state['workspaceId'] = value['workspace']['workspaceId']
                state['workspaceCreated'] = value.get('created')
            if not mutate('workspace/create', {'request': {'path': str(workspace)}}, 'workspace_pending', 'registered', registered):
                return 2
        if state['phase'] == 'registered':
            if not mutate('session/create', {'request': {'workspaceId': state['workspaceId']}}, 'session_pending', 'created',
                          lambda value: state.update(sessionId=value['sessionId'])):
                return 2
        if state['phase'] == 'created':
            if not mutate('session/rename', {'request': {'sessionId': state['sessionId'], 'title': args.title}},
                          'rename_pending', 'named', lambda value: None):
                return 2
        listing = rpc('session/list', {'_request': {}})
        if not listing.get('ok'):
            raise ValueError('Cannot verify new session before dispatch')
        item = next((x for x in listing['value']['items'] if x.get('sessionId') == state['sessionId']), None)
        if not item or item.get('cwd') != str(workspace) or item.get('origin') == 'subagent':
            raise ValueError('Session/workspace identity mismatch; task not dispatched')
        def accepted(value):
            if value.get('accepted') is not True:
                raise ValueError('No acceptance confirmation')
            state['receipt'] = value
        if not mutate('session/prompt', {'request': {'sessionId': state['sessionId'], 'requestId': args.request_id,
                      'mode': 'queue', 'content': [{'type': 'text', 'text': text}], 'clientTimeZone': 'Asia/Shanghai'}},
                      'prompt_pending', 'accepted', accepted):
            return 2
        print(json.dumps({'status': 'accepted', 'state': state}, ensure_ascii=False))
        return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        # Exception messages from HTTP/auth can contain authentication URLs. Print only the class.
        print('Stopped; inspect private state and identity. Error type: ' + type(exc).__name__, file=sys.stderr)
        sys.exit(1)
