#!/usr/bin/env python3
"""Route only the relay UID through WireGuard, with no direct-egress fallback.

Usage (root): relay-wireguard.py up PRIVATE_CONF | down
No wg-quick hooks, global default-route changes, or credential output.
"""
import configparser
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import tempfile

interface = 'ssrelaywg'
table = '18790'
route_priority = '18790'
block_priority = '18791'
uid = str(pwd.getpwnam('live-subtitle-relay').pw_uid)
uid_range = uid + '-' + uid
stage = 'configuration'


def command(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)


def rule(family, operation, priority, action):
    return command('ip', family, 'rule', operation, 'priority', priority,
                   'uidrange', uid_range, *action, check=operation == 'add')


def down():
    # Remove the lookup before the block, so teardown cannot briefly bypass VPN.
    for family in ['-4', '-6']:
        rule(family, 'delete', route_priority, ['lookup', table])
        command('ip', family, 'route', 'delete', 'default', 'dev', interface,
                'table', table, check=False)
    command('ip', 'link', 'delete', interface, check=False)
    for family in ['-4', '-6']:
        rule(family, 'delete', block_priority, ['prohibit'])


created_interface = False
added_rules = []
try:
    if sys.argv[1] == 'down':
        down()
        print('Relay VPN interface and owned routing rules removed.')
        sys.exit(0)
    if sys.argv[1] != 'up':
        raise ValueError()
    os.umask(0o077)
    config = configparser.ConfigParser()
    config.read_string(Path(sys.argv[2]).read_text())
    if config.sections() != ['Interface', 'Peer']:
        raise ValueError()
    addresses = [str(ipaddress.ip_interface(value.strip())) for value in config['Interface']['Address'].split(',')]
    host, port = config['Peer']['Endpoint'].rsplit(':', 1)
    ipaddress.IPv4Address(host)
    if not 0 < int(port) < 65536:
        raise ValueError()
    private_key = config['Interface']['PrivateKey']
    public_key = config['Peer']['PublicKey']
    if not all(re.fullmatch(r'[A-Za-z0-9+/]{43}=', key) for key in [private_key, public_key]):
        raise ValueError()
    stage = 'routing-conflict-check'
    stage = 'interface-conflict-check'
    if command('ip', 'link', 'show', interface, check=False).returncode == 0:
        raise ValueError()
    for family in ['-4', '-6']:
        stage = 'rule-conflict-check-' + family[-1]
        existing = json.loads(command('ip', family, '-json', 'rule', 'show').stdout)
        if any(str(item.get('priority')) in [route_priority, block_priority] for item in existing):
            raise ValueError()
        stage = 'table-conflict-check-' + family[-1]
        routes = command('ip', family, '-json', 'route', 'show', 'table', table, check=False)
        if routes.returncode == 0:
            if json.loads(routes.stdout):
                raise ValueError()
        elif 'fib table does not exist' not in routes.stderr.lower():
            raise ValueError()
    stage = 'direct-egress-block'
    for family in ['-4', '-6']:
        rule(family, 'add', block_priority, ['prohibit'])
        added_rules.append((family, block_priority, ['prohibit']))
    stage = 'wireguard-interface'
    command('ip', 'link', 'add', interface, 'type', 'wireguard')
    created_interface = True
    with tempfile.TemporaryDirectory(prefix='substream-wireguard-') as temporary:
        path = Path(temporary) / 'wg.conf'
        path.write_text('[Interface]\nPrivateKey = ' + private_key
                        + '\n[Peer]\nPublicKey = ' + public_key
                        + '\nEndpoint = ' + host + ':' + port
                        + '\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n')
        path.chmod(0o600)
        command('wg', 'setconf', interface, str(path))
    for address in addresses:
        command('ip', 'address', 'add', address, 'dev', interface)
    command('ip', 'link', 'set', interface, 'mtu', '1380', 'up')
    stage = 'relay-only-routing'
    for family in ['-4', '-6']:
        command('ip', family, 'route', 'add', 'default', 'dev', interface, 'table', table)
        rule(family, 'add', route_priority, ['lookup', table])
        added_rules.append((family, route_priority, ['lookup', table]))
    print('Relay-only WireGuard routing configured for IPv4/IPv6; direct egress prohibited on tunnel loss.')
except Exception as error:
    for family, priority, action in reversed(added_rules):
        rule(family, 'delete', priority, action)
    if created_interface:
        command('ip', 'link', 'delete', interface, check=False)
    print('Relay VPN setup failed at ' + stage + '; private details suppressed. Service must remain stopped.')
    if isinstance(error, subprocess.CalledProcessError):
        text = (error.stderr or '').lower()
        reason = ('permission-denied' if 'not permitted' in text or 'permission denied' in text
                  else 'address-family-unavailable' if 'address family' in text
                  else 'command-failed')
        print('Safe setup reason=' + reason + '.')
    else:
        print('Safe setup exception=' + type(error).__name__ + '.')
    sys.exit(1)
