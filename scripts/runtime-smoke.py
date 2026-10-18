#!/usr/bin/env python3
"""Boot both production entries on fresh local databases before a release."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
LOCK = Path('/tmp/porchsite-suite.lock')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock-held', action='store_true', help='caller already owns the suite lock and releases it')
    parser.add_argument('--output', type=Path, help='retain build, startup logs and request records here')
    args = parser.parse_args()
    out = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix='porchsite-runtime-smoke-'))
    out.mkdir(parents=True, exist_ok=True)
    owned = None
    if args.lock_held:
        if not LOCK.is_dir():
            raise RuntimeError('--lock-held requires the caller-owned suite directory')
    else:
        LOCK.mkdir()  # Refusal must happen before any process or cleanup handler.
        owned = LOCK.stat().st_ino
    deadline = time.monotonic() + 60
    def terminate(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    processes = []
    records = []
    database = 'porchsite_smoke_' + secrets.token_hex(6)
    created = False
    result = {'requests': records, 'pass': False}
    env = {**os.environ, 'CI': '1', 'WRANGLER_SEND_METRICS': 'false', 'NO_COLOR': '1',
           'PYTHONPATH': str(ROOT / 'server'), 'PUBLIC_ARTIFACTS': '', 'PORCHSITE_PUBLIC_ARTIFACTS': ''}
    admin = os.environ.get('PORCHSITE_TEST_DSN', '')

    def remaining():
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError('runtime smoke exceeded its 60 second budget')
        return left

    def stop(proc):
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        if proc.poll() is None:
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=3)

    def launch(command, log, extra=None):
        with (out / log).open('w') as handle:
            proc = subprocess.Popen(command, cwd=out, env={**env, **(extra or {})},
                                    stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(proc)
        return proc

    def checked(command, log):
        proc = launch(command, log)
        try:
            code = proc.wait(timeout=remaining())
        finally:
            stop(proc)
        if code:
            raise RuntimeError(f'{log}: command exited {code}')

    async def db(action):
        nonlocal created
        import asyncpg
        conn = await asyncpg.connect(admin, timeout=5)
        try:
            await conn.execute(f'{action} DATABASE "{database}"')
            if action == 'CREATE':
                created = True
        finally:
            await conn.close()

    def port():
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            return sock.getsockname()[1]

    def request(base, path, headers=None, body=None, method=None, oauth_cors=False):
        req = Request(base + path, headers=headers or {}, data=body, method=method)
        try:
            response = urlopen(req, timeout=min(2, remaining()))
        except HTTPError as error:
            response = error
        with response:
            if oauth_cors:
                expected = {k.lower(): v for k,v in json.loads((ROOT / 'spec/fixtures/oauth-cors.json').read_text())['headers'].items()}
                actual = {k.lower(): v for k,v in response.headers.items() if k.lower().startswith('access-control-')}
                if actual != expected or response.headers.get_all('Access-Control-Allow-Origin') != ['*']:
                    raise RuntimeError(f'{path}: OAuth CORS map or singleton Allow-Origin differs')
                if any(token.strip().lower() == 'origin' for value in response.headers.get_all('Vary', []) for token in value.split(',')):
                    raise RuntimeError(f'{path}: OAuth response still varies by Origin')
            return response.status, dict(response.headers), response.read()

    def ready(proc, base):
        while True:
            if proc.poll() is not None:
                raise RuntimeError(f'runtime exited before readiness ({proc.returncode})')
            try:
                status, _, _ = request(base, '/robots.txt')
                if status >= 500:
                    raise RuntimeError(f'readiness returned HTTP {status}')
                return
            except (URLError, TimeoutError, ConnectionError):
                remaining()
                time.sleep(.1)

    def probe(edition, base):
        etag = None
        for path in ['/', '/index.md', '/llms.txt', '/mcp']:
            mcp = path == '/mcp'
            status, headers, body = request(base, path,
                {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'} if mcp else {},
                b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' if mcp else None)
            records.append({'edition': edition, 'method': 'POST' if mcp else 'GET', 'path': path,
                            'status': status, 'bytes': len(body), 'headers': headers})
            if status != (401 if mcp else 200):
                raise RuntimeError(f'{edition} {path}: unexpected HTTP {status}')
            if path == '/':
                etag = next((v for k, v in headers.items() if k.lower() == 'etag'), None)
        # Native Response maps miss runtime framing changes. Check actual HTTP:
        # RFC 9110 §8.6 forbids even Content-Length: 0 on a 204.
        for case, authorization in [('absent', None), ('writer', 'Bearer psk_invalid'),
                                    ('reader', 'Bearer prk_invalid'), ('oauth', 'Bearer owner:missing:token'),
                                    ('malformed', 'Bearer one two')]:
            status, headers, body = request(base, '/mcp',
                {'Authorization': authorization} if authorization else {}, method='OPTIONS')
            records.append({'edition': edition, 'method': 'OPTIONS', 'path': '/mcp',
                            'credential_case': case,
                            'status': status, 'bytes': len(body), 'headers': headers})
            if status != 204 or body or any(k.lower() == 'content-length' for k in headers):
                raise RuntimeError(f'{edition} MCP preflight must be an empty 204 without Content-Length')
        if not etag:
            raise RuntimeError(f'{edition} home has no public validator')
        status, headers, body = request(base, '/', {'If-None-Match': etag})
        records.append({'edition': edition, 'method': 'GET', 'path': '/', 'conditional': True,
                        'status': status, 'bytes': len(body), 'headers': headers})
        if status != 304 or body:
            raise RuntimeError(f'{edition} conditional home must be an empty 304')
        for path in json.loads((ROOT / 'spec/fixtures/oauth-preflight-paths.json').read_text()):
            for caller in [None, 'https://caller.example']:
                origin_headers = {'Origin': caller} if caller else {}
                for case, authorization in [('absent', None), ('bearer', 'Bearer psk_invalid'), ('basic', 'Basic unused')]:
                    status, headers, body = request(base, path,
                        {**origin_headers, **({'Authorization': authorization} if authorization else {})}, method='OPTIONS', oauth_cors=True)
                    records.append({'edition': edition, 'method': 'OPTIONS', 'path': path,
                                    'caller_origin': caller, 'credential_case': case, 'status': status, 'bytes': len(body), 'headers': headers})
                    if status != 204 or body or any(k.lower() == 'content-length' for k in headers):
                        raise RuntimeError(f'{edition} {path}: OAuth preflight must be an empty 204 without Content-Length')
                methods = ['GET','HEAD'] if path.startswith('/.well-known/') else ['POST']
                for method in methods:
                    status, headers, body = request(base, path,
                        {**origin_headers, **({'Content-Type':'application/json'} if method == 'POST' else {})},
                        b'{}' if method == 'POST' else None, method=method, oauth_cors=True)
                    records.append({'edition': edition, 'method': method, 'path': path,
                                    'caller_origin': caller, 'status': status, 'bytes': len(body), 'headers': headers})
                    expected = 404 if edition == 'worker' and path == '/.well-known/oauth-protected-resource' else 200
                    if (method != 'POST' and status != expected) or (method == 'POST' and status < 400):
                        raise RuntimeError(f'{edition} {path}: unexpected OAuth protocol status {status}')
                if path == '/oauth/register':
                    payload = json.dumps({'client_name':'Runtime test','redirect_uris':['https://app.example/callback'],'token_endpoint_auth_method':'none'}).encode()
                    status, headers, body = request(base, path, {**origin_headers,'Content-Type':'application/json'},payload,method='POST',oauth_cors=True)
                    records.append({'edition':edition,'method':'POST','path':path,'valid_registration':True,
                                    'caller_origin':caller,'status':status,'bytes':len(body),'headers':headers})
                    if status != 201 or not json.loads(body).get('client_id'):
                        raise RuntimeError(f'{edition}: valid OAuth registration failed')


    try:
        address = urlsplit(admin)
        if address.hostname not in ('localhost', '127.0.0.1', '::1') or address.port != 5433:
            raise RuntimeError('PORCHSITE_TEST_DSN must name a disposable local PostgreSQL on port 5433')
        wrangler = ROOT / 'cloudflare/node_modules/wrangler/bin/wrangler.js'
        worker_port, server_port = port(), port()
        config = out / 'wrangler.json'
        release = os.environ.get('VERSION', 'runtime-smoke')
        settings = {'name': 'runtime-smoke', 'define': {'__RELEASE__': json.dumps(release)}, 'main': str(ROOT / 'cloudflare/src/index.ts'),
                    'compatibility_date': '2026-08-15', 'compatibility_flags': ['nodejs_compat', 'global_fetch_strictly_public'],
                    'd1_databases': [{'binding': 'DB', 'database_name': 'runtime-smoke',
                        'database_id': '00000000-0000-4000-8000-000000000000', 'migrations_dir': str(ROOT / 'cloudflare/migrations')}],
                    'kv_namespaces': [{'binding': 'OAUTH_KV', 'id': 'runtime-smoke'}],
                    'vars': {'SITE_URL': f'http://localhost:{worker_port}', 'PUBLIC_ARTIFACTS': ''}}
        config.write_text(json.dumps(settings))
        command = ['node', str(wrangler)]
        checked(command + ['deploy', '--dry-run', '--minify', '--config', str(config), '--outdir', str(out / 'bundle')], 'build.log')
        bundle = out / 'bundle/index.js'
        result['worker_sha256'] = hashlib.sha256(bundle.read_bytes()).hexdigest()
        settings.update(main=str(bundle), no_bundle=True)
        config.write_text(json.dumps(settings))
        checked(command + ['d1', 'migrations', 'apply', 'runtime-smoke', '--local', '--config', str(config),
                           '--persist-to', str(out / 'state')], 'migrations.log')
        asyncio.run(db('CREATE'))
        created = True
        dsn = urlunsplit((address.scheme, address.netloc, '/' + database, address.query, ''))
        worker = launch(command + ['dev', '--local', '--config', str(config), '--ip', '127.0.0.1',
                                  '--port', str(worker_port), '--persist-to', str(out / 'state'),
                                  '--show-interactive-dev-session=false'], 'worker.log')
        server = launch([sys.executable, '-m', 'uvicorn', 'server.app.main:app', '--host', '127.0.0.1',
                         '--port', str(server_port), '--log-level', 'warning'], 'server.log',
                        {'PORCHSITE_DSN': dsn, 'PORCHSITE_SITE_URL': f'http://localhost:{server_port}', 'PORCHSITE_SETUP_CODE': '', 'PORCHSITE_RELEASE': release})
        for edition, proc, base in [('worker', worker, f'http://127.0.0.1:{worker_port}'),
                                    ('server', server, f'http://127.0.0.1:{server_port}')]:
            ready(proc, base)
            probe(edition, base.replace('127.0.0.1', 'localhost'))
        result['pass'] = True
    except Exception as error:
        result['error'] = str(error)
    finally:
        for proc in reversed(processes):
            stop(proc)
        if created:
            try:
                asyncio.run(db('DROP'))
                result['database_dropped'] = True
            except Exception as error:
                result.update({'pass': False, 'cleanup_error': str(error)})
        shutil.rmtree(out / 'state', ignore_errors=True)
        result['seconds'] = round(60 - (deadline - time.monotonic()), 3)
        (out / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        if owned is not None and LOCK.exists() and LOCK.stat().st_ino == owned:
            LOCK.rmdir()
    print(f"runtime smoke: {'PASS' if result['pass'] else 'FAIL'}; evidence {out}")
    return 0 if result['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
