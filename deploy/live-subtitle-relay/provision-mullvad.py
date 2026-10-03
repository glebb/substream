#!/usr/bin/env python3
"""Create private Finnish configs with a dedicated device; never activate routing.

API contract: https://github.com/mullvad/wg-tools/blob/main/wg-mullvad.py
Usage (root): provision-mullvad.py PRIVATE_ACCOUNT_FILE PRIVATE_OUTPUT_DIRECTORY
Account data and API tokens are never passed as arguments or printed.
"""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

stage = 'configuration'


def private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(value)
    os.chmod(path, 0o600)


def api(path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(
        'https://api.mullvad.net' + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


try:
    os.umask(0o077)
    account = re.sub(r'\s+', '', Path(sys.argv[1]).read_text())
    if not re.fullmatch(r'\d{16}', account):
        raise ValueError()
    output = Path(sys.argv[2])
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.chmod(0o700)
    stage = 'account-authentication'
    token = api('/auth/v1/webtoken', {'account_number': account})['access_token']
    account_info = api('/accounts/v1/accounts/me', token=token)
    expiry = datetime.datetime.fromisoformat(account_info['expiry'].replace('Z', '+00:00'))
    if expiry <= datetime.datetime.now(datetime.timezone.utc):
        print('Mullvad account has no remaining paid time; private details suppressed.')
        sys.exit(1)
    stage = 'relay-selection'
    relays = [relay for relay in api('/www/relays/all')
              if relay.get('type') == 'wireguard' and relay.get('active')
              and relay.get('hostname', '').startswith('fi-hel-')]
    # This Blix endpoint completed the server's isolated VPN/live-stream check.
    relays.sort(key=lambda relay: (relay['hostname'] != 'fi-hel-wg-101',
                                   not relay.get('owned', False), relay['hostname']))
    if not relays:
        raise ValueError()
    stage = 'device-key'
    key_path = output / 'private-key'
    if key_path.exists():
        key = key_path.read_text().strip()
        key_path.chmod(0o600)
    else:
        key = subprocess.run(['wg', 'genkey'], capture_output=True, text=True, check=True).stdout.strip()
        private_write(key_path, key + '\n')
    public_key = subprocess.run(['wg', 'pubkey'], input=key + '\n', capture_output=True,
                                text=True, check=True).stdout.strip()
    stage = 'device-registration'
    devices = api('/accounts/v1/devices', token=token)
    device = next((device for device in devices if device['pubkey'] == public_key), None)
    if device is None:
        if not account_info.get('can_add_devices', False):
            print('Mullvad device limit reached. Remove an unused device in your account; existing devices were preserved.')
            sys.exit(1)
        device = api('/accounts/v1/devices', {'pubkey': public_key, 'hijack_dns': False}, token)
    private_write(output / 'device.json', json.dumps(device))
    stage = 'config-files'
    for relay in relays:
        if not re.fullmatch(r'fi-hel-wg-\d+', relay['hostname']):
            raise ValueError()
        config = ('[Interface]\nPrivateKey = ' + key
                  + '\nAddress = ' + device['ipv4_address'] + ', ' + device['ipv6_address']
                  + '\nDNS = 10.64.0.1\nMTU = 1380\n\n[Peer]\nPublicKey = ' + relay['pubkey']
                  + '\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = ' + relay['ipv4_addr_in']
                  + ':51820\nPersistentKeepalive = 25\n')
        private_write(output / (relay['hostname'] + '.conf'), config)
    private_write(output / 'mullvad-fi.conf', (output / (relays[0]['hostname'] + '.conf')).read_text())
    print('Mullvad paid time verified. Dedicated device registered/reused; '
          + str(len(relays)) + ' private Finnish configs created. No routing activated.')
except urllib.error.HTTPError as error:
    print('Mullvad provisioning failed at ' + stage + '; HTTP status ' + str(error.code)
          + '. Raw account/API details suppressed.')
    sys.exit(1)
except Exception:
    print('Mullvad provisioning failed at ' + stage + '; private details suppressed.')
    sys.exit(1)
