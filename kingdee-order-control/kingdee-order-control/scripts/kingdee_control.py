#!/usr/bin/env python3
"""Submit one command to the local Kingdee userscript bridge and wait for its result."""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ACTIONS = {'status','load-orders','next-order','previous-order','switch-type','fill-codes','paste-codes','paste-quantity-price','paste-price','smart-fill','repair','check-amount','clear','refresh'}

def request(base, path, data=None, timeout=5):
    body = None if data is None else json.dumps(data).encode('utf-8')
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    req = urllib.request.Request(base.rstrip('/') + path, data=body, headers=headers, method='GET' if body is None else 'POST')
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8') or '{}')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=sorted(ACTIONS))
    parser.add_argument('--base-url', default='http://127.0.0.1:8766')
    parser.add_argument('--type', choices=['purchase','sales'], help='Required for switch-type')
    parser.add_argument('--timeout', type=float, default=30)
    args = parser.parse_args()
    if args.action == 'switch-type' and not args.type:
        parser.error('--type purchase|sales is required for switch-type')
    command = {'action': args.action}
    if args.type:
        command['type'] = args.type
    try:
        accepted = request(args.base_url, '/api/jdy/command', command)
        command_id = accepted.get('id')
        if not accepted.get('accepted') or command_id is None:
            raise RuntimeError(f'Bridge rejected command: {accepted}')
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            path = '/api/jdy/result?' + urllib.parse.urlencode({'id': command_id})
            result = request(args.base_url, path, timeout=5)
            if result.get('id') == command_id and 'success' in result:
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0 if result['success'] else 1
            time.sleep(0.35)
        raise TimeoutError(f'Command {command_id} timed out; ensure the userscript is loaded on an open Kingdee page.')
    except (urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        print(json.dumps({'success': False, 'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2

if __name__ == '__main__':
    raise SystemExit(main())
