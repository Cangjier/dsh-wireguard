import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateKeyPair } from '../src/lib/keys';
import { WireGuardService } from '../src/lib/service';

function fakePlatform(overrides = {}) {
  return {
    platform: 'linux',
    isWindows: false,
    isLinux: true,
    admin: true,
    wg: '/usr/bin/wg',
    wireguard: null,
    ip: '/usr/sbin/ip',
    sudo: null,
    iptables: null,
    nft: null,
    sysctl: null,
    ...overrides,
  };
}

function fakeTunnel() {
  return {
    peerAdds: [],
    peerRemoves: [],
    serverInput: null,
    clientInput: null,
    downCalls: 0,
    async upServer(input) {
      this.serverInput = input;
      return { warnings: [] };
    },
    async upClient(input) {
      this.clientInput = input;
    },
    async down() {
      this.downCalls += 1;
    },
    async addPeer(interfaceName, peer) {
      this.peerAdds.push({ interfaceName, peer });
    },
    async removePeer(interfaceName, publicKey) {
      this.peerRemoves.push({ interfaceName, publicKey });
    },
    async status() {
      return { up: true, publicKey: Buffer.alloc(32, 3).toString('base64'), listenPort: 51820, peers: [] };
    },
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function withService(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wireguard-test-'));
  const tunnel = fakeTunnel();
  const service = new WireGuardService({
    dataDir,
    platformFactory: async () => fakePlatform(),
    tunnelFactory: () => tunnel,
    log: () => {},
  });
  await service.init();
  try {
    await run({ service, tunnel, dataDir });
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('starts a control panel, joins a peer, and never exposes the join code on health', async () => {
  await withService(async ({ service, tunnel }) => {
    const port = await freePort();
    const state = await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'secret-code',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    assert.equal(state.server.running, true);
    assert.equal(state.server.controlAvailable, true);
    assert.equal(tunnel.serverInput.peers.length, 0);

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.service, 'dsh-wireguard');
    assert.equal(health.joinRequired, true);
    assert.equal(Object.prototype.hasOwnProperty.call(health, 'joinCode'), false);

    const wrong = await fetch(`http://127.0.0.1:${port}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad', publicKey: generateKeyPair().publicKey, code: 'wrong' }),
    });
    assert.equal(wrong.status, 401);

    const client = generateKeyPair();
    const joinResponse = await fetch(`http://127.0.0.1:${port}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'laptop-b', publicKey: client.publicKey, code: 'secret-code' }),
    });
    assert.equal(joinResponse.status, 200);
    const joined = await joinResponse.json();
    assert.equal(joined.client.ip, '10.66.66.2');
    assert.equal(joined.server.endpoint, '192.168.1.10:51820');
    assert.equal(tunnel.peerAdds.length, 1);

    const peersUnauthorized = await fetch(`http://127.0.0.1:${port}/peers`);
    assert.equal(peersUnauthorized.status, 401);
    const peersAuthorized = await fetch(`http://127.0.0.1:${port}/peers?code=secret-code`);
    assert.equal(peersAuthorized.status, 200);
    const peers = await peersAuthorized.json();
    assert.equal(peers.peers[0].name, 'laptop-b');
    assert.equal(Object.prototype.hasOwnProperty.call(peers.peers[0], 'publicKey'), false);

    const leaveResponse = await fetch(`http://127.0.0.1:${port}/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: client.publicKey, code: 'secret-code' }),
    });
    assert.equal(leaveResponse.status, 200);
    assert.equal((await leaveResponse.json()).removed, true);
    assert.equal(service.snapshot().server.peers.length, 0);

    await service.stopServer();
    assert.equal(service.snapshot().server.running, false);
    assert.ok(tunnel.downCalls >= 1);
  });
});

test('joins a server as a client, writes a config, and disconnects cleanly', async () => {
  const serverKeys = generateKeyPair();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({
        ok: true,
        service: 'dsh-wireguard',
        publicKey: serverKeys.publicKey,
        vpnCidr: '10.66.66.0/24',
        listenPort: 51820,
        mtu: 1420,
        dns: '',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/join')) {
      return new Response(JSON.stringify({
        ok: true,
        client: { ip: '10.66.66.2', address: '10.66.66.2/32', name: 'laptop-b' },
        server: { publicKey: serverKeys.publicKey, endpoint: '192.168.1.10:51820', vpnCidr: '10.66.66.0/24' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/leave')) {
      return new Response(JSON.stringify({ ok: true, removed: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wireguard-client-test-'));
  const tunnel = fakeTunnel();
  const service = new WireGuardService({
    dataDir,
    platformFactory: async () => fakePlatform(),
    tunnelFactory: () => tunnel,
    fetchImpl,
    log: () => {},
  });
  await service.init();
  try {
    const state = await service.connectClient({ serverAddress: '192.168.1.10:51821', joinCode: 'secret' });
    assert.equal(state.client.connected, true);
    assert.equal(state.client.assignedIp, '10.66.66.2');
    assert.equal(state.client.publicKeyFingerprint.length > 0, true);
    assert.equal(Object.prototype.hasOwnProperty.call(state.client, 'joinCode'), false);
    assert.ok(tunnel.clientInput);
    assert.equal(tunnel.clientInput.endpoint, '192.168.1.10:51820');
    assert.match(tunnel.clientInput.configPath, /client\.conf$/);
    assert.equal(requests.filter((entry) => entry.url.endsWith('/join')).length, 1);

    const disconnected = await service.disconnectClient();
    assert.equal(disconnected.client.connected, false);
    assert.equal(disconnected.client.pending, false);
    assert.equal(requests.filter((entry) => entry.url.endsWith('/leave')).length, 1);
    assert.ok(tunnel.downCalls >= 1);
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
