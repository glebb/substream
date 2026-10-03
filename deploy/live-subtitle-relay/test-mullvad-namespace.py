#!/usr/bin/env python3
"""Run a safe diagnostic in a temporary WireGuard-only namespace.

The encrypted UDP socket is created in the host namespace before moving its
interface, so only the diagnostic gets VPN routes. No wg-quick hooks execute.
Usage (root): test-mullvad-namespace.py PRIVATE_CONF COMMAND [ARGS...]
"""
import configparser
import ipaddress
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile

namespace = 'substream-vpn-test'
interface = 'sswgtest'
created_namespace = False
created_interface = False
created_dns = False
dns_root = Path('/etc/netns') / namespace
stage = 'private-config'


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


try:
    config = configparser.ConfigParser()
    config.read_string(Path(sys.argv[1]).read_text())
    if config.sections() != ['Interface', 'Peer'] or len(sys.argv) < 3:
        raise ValueError()
    addresses = [str(ipaddress.ip_interface(value.strip())) for value in config['Interface']['Address'].split(',')]
    dns = [str(ipaddress.ip_address(value.strip())) for value in config['Interface']['DNS'].split(',')]
    endpoint = config['Peer']['Endpoint']
    # Generated configs use a numeric IPv4 endpoint, not arbitrary commands.
    host, port = endpoint.rsplit(':', 1)
    ipaddress.IPv4Address(host)
    if not 0 < int(port) < 65536:
        raise ValueError()
    private_key = config['Interface']['PrivateKey']
    public_key = config['Peer']['PublicKey']
    if not all(re.fullmatch(r'[A-Za-z0-9+/]{43}=', key) for key in [private_key, public_key]):
        raise ValueError()
    stage = 'namespace-create'
    run('ip', 'netns', 'add', namespace)
    created_namespace = True
    stage = 'wireguard-interface'
    run('ip', 'link', 'add', interface, 'type', 'wireguard')
    created_interface = True
    stage = 'wireguard-key-config'
    with tempfile.TemporaryDirectory(prefix='substream-wg-') as temporary:
        stripped = Path(temporary) / 'wg.conf'
        stripped.write_text('[Interface]\nPrivateKey = ' + private_key
                            + '\n[Peer]\nPublicKey = ' + public_key
                            + '\nEndpoint = ' + endpoint
                            + '\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n')
        stripped.chmod(0o600)
        run('wg', 'setconf', interface, str(stripped))
    stage = 'interface-namespace-move'
    run('ip', 'link', 'set', interface, 'netns', namespace)
    created_interface = False  # Namespace deletion now owns interface cleanup.
    stage = 'namespace-routing'
    run('ip', '-n', namespace, 'link', 'set', 'lo', 'up')
    for address in addresses:
        stage = 'namespace-address'
        run('ip', '-n', namespace, 'address', 'add', address, 'dev', interface)
    stage = 'namespace-interface-up'
    run('ip', '-n', namespace, 'link', 'set', interface, 'mtu', '1380', 'up')
    stage = 'namespace-ipv4-route'
    run('ip', '-n', namespace, 'route', 'add', 'default', 'dev', interface)
    stage = 'namespace-ipv6-route'
    run('ip', '-n', namespace, '-6', 'route', 'add', 'default', 'dev', interface)
    stage = 'namespace-dns'
    dns_root.mkdir(mode=0o755, parents=True)
    created_dns = True
    (dns_root / 'resolv.conf').write_text(''.join('nameserver ' + value + '\n' for value in dns))
    stage = 'diagnostic'
    # Only credential-safe diagnostics should be supplied as this command.
    process = subprocess.Popen(['ip', 'netns', 'exec', namespace, *sys.argv[2:]],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise
    print(stdout, end='')
    for line in stderr.splitlines():
        if re.fullmatch(r'VPN provider check failed at [a-z-]+; raw network details suppressed\.', line) or re.fullmatch(r'Safe worker failure reason=[a-z-]+\.', line):
            print(line)
    if process.returncode:
        print('Isolated VPN diagnostic did not pass; raw stderr suppressed.')
    sys.exit(process.returncode)
except Exception:
    print('Isolated VPN test failed at ' + stage + '; private config and raw command errors suppressed.')
    sys.exit(1)
finally:
    if created_namespace:
        subprocess.run(['ip', 'netns', 'delete', namespace], capture_output=True)
    if created_interface:
        subprocess.run(['ip', 'link', 'delete', interface], capture_output=True)
    if created_dns:
        shutil.rmtree(dns_root)
