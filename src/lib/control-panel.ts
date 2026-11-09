/** The LAN-facing WireGuard control-panel HTTP service. */

import { createServer } from 'node:http';
import { MAX_REQUEST_BYTES } from './constants';
import { WireGuardError } from './errors';

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

/**
 * Escape text placed in the small server-rendered status page.
 * @param {unknown} value text.
 * @returns {string} HTML-safe text.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Read and parse a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {number} limit byte limit.
 * @returns {Promise<Record<string, unknown>>} parsed object.
 */
async function readJson(request: import('node:http').IncomingMessage, limit = MAX_REQUEST_BYTES): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new WireGuardError('request_too_large', 'Request body is too large.', { status: 413 });
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new WireGuardError('invalid_json', 'Request body is not valid JSON.', { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WireGuardError('invalid_json', 'Request body must be a JSON object.', { status: 400 });
  }
  return parsed;
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response response.
 * @param {number} status HTTP status.
 * @param {unknown} value JSON value.
 * @returns {void}
 */
function writeJson(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export interface ControlPanelOptions {
  getServerInfo: () => Record<string, unknown>;
  getPeers: () => Array<Record<string, unknown>>;
  onJoin: (request: Record<string, unknown>, remoteAddress: string) => Promise<Record<string, unknown>>;
  onLeave: (request: Record<string, unknown>, remoteAddress: string) => Promise<Record<string, unknown>>;
  log?: (message: string) => void;
}

/**
 * The HTTP service clients call to join a server. It is deliberately separate
 * from the Harness web server so a remote client can reach it on the LAN.
 */
export class ControlPanel {
  private readonly options: ControlPanelOptions;
  private server: import('node:http').Server | null;
  private port: number | null;
  private readonly attempts: Map<string, number[]>;
  private readonly log: (message: string) => void;

  constructor(options: ControlPanelOptions) {
    this.options = options;
    this.server = null;
    this.port = null;
    this.attempts = new Map();
    this.log = options.log ?? (() => {});
  }

  async start(port: number, host = '0.0.0.0'): Promise<{ port: number; host: string }> {
    if (this.server) throw new WireGuardError('already_running', 'The control panel is already running.', { status: 409 });
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.log(`control panel request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) writeJson(response, 500, { ok: false, error: { code: 'internal_error', message: 'The control panel request failed.' } });
        else response.destroy();
      });
    });
    server.keepAliveTimeout = 10_000;
    server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(new WireGuardError('port_in_use', `Control-panel port ${port} is already in use.`, {
            status: 409,
            hint: 'Choose another control-panel port on the Service tab and start again.',
          }));
        } else {
          reject(new WireGuardError('control_error', `Could not start the control panel: ${error.message}`, { status: 500, cause: error }));
        }
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
    this.server = server;
    this.port = port;
    this.log(`control panel listening on ${host}:${port}`);
    return { port, host };
  }

  /**
   * Stop the listener and every retained connection.
   * @returns {Promise<void>}
   */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
      setTimeout(resolve, 1500).unref?.();
    });
  }

  /**
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {Promise<void>}
   */
  async handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://control-panel.invalid');
    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    if (!this.allow(remoteAddress)) {
      writeJson(response, 429, { ok: false, error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } });
      return;
    }

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      this.writePage(response);
      return;
    }
    if (method === 'GET' && url.pathname === '/health') {
      const { joinCode: _joinCode, ...publicInfo } = this.options.getServerInfo();
      writeJson(response, 200, { ok: true, service: 'dsh-wireguard', ...publicInfo });
      return;
    }
    if (method === 'GET' && url.pathname === '/peers') {
      try {
        this.assertCode(url.searchParams.get('code') ?? '');
        writeJson(response, 200, { ok: true, peers: this.options.getPeers() });
      } catch (error) {
        this.writeError(response, error);
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/join') {
      try {
        const body = await readJson(request);
        if (!body.code && url.searchParams.get('code')) body.code = url.searchParams.get('code');
        const result = await this.options.onJoin(body, remoteAddress);
        writeJson(response, 200, { ok: true, ...result });
      } catch (error) {
        this.writeError(response, error);
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/leave') {
      try {
        const body = await readJson(request);
        const result = await this.options.onLeave(body, remoteAddress);
        writeJson(response, 200, { ok: true, ...result });
      } catch (error) {
        this.writeError(response, error);
      }
      return;
    }
    writeJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown control-panel endpoint.' } });
  }

  /**
   * Validate the optional join code against the live server configuration.
   * @param {string} supplied code from a request.
   * @returns {void}
   */
  assertCode(supplied: string): void {
    const info = this.options.getServerInfo();
    const required = info.joinRequired === true;
    if (required && supplied !== info.joinCode) {
      throw new WireGuardError('invalid_join_code', 'The join code is missing or incorrect.', { status: 401 });
    }
  }

  /**
   * Fixed-window per-IP rate limit. LAN join traffic is tiny; this only stops
   * runaway retries and casual probing.
   * @param {string} key remote address.
   * @returns {boolean} whether the request is admitted.
   */
  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter((stamp) => now - stamp < RATE_WINDOW_MS);
    recent.push(now);
    this.attempts.set(key, recent);
    if (this.attempts.size > 512) {
      for (const [address, stamps] of this.attempts) {
        if (stamps.every((stamp) => now - stamp >= RATE_WINDOW_MS)) this.attempts.delete(address);
      }
    }
    return recent.length <= RATE_LIMIT;
  }

  /**
   * @param {import('node:http').ServerResponse} response response.
   * @param {unknown} error failure.
   * @returns {void}
   */
  writeError(response, error) {
    if (error instanceof WireGuardError) {
      writeJson(response, error.status, { ok: false, error: error.toJSON() });
      return;
    }
    this.log(`control panel operation failed: ${error instanceof Error ? error.message : String(error)}`);
    writeJson(response, 500, { ok: false, error: { code: 'internal_error', message: 'The control-panel operation failed.' } });
  }

  /**
   * Render the unauthenticated status page shown when the port is opened in a
   * browser. It never includes the join code or peer identities.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {void}
   */
  writePage(response) {
    const info = this.options.getServerInfo();
    const peers = this.options.getPeers();
    const endpoint = escapeHtml(info.endpoint ?? 'not available');
    const control = escapeHtml(`http://${info.endpointHost ?? 'server'}:${info.controlPort ?? ''}`);
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>WireGuard control panel</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #152033; }
main { width: min(640px, calc(100vw - 40px)); margin: 40px 0; padding: 28px; border-radius: 18px; background: #fff; box-shadow: 0 18px 60px rgba(23, 44, 75, .12); }
h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -.02em; }
p { color: #5b6b82; line-height: 1.55; }
.badge { display: inline-block; padding: 3px 9px; border-radius: 999px; background: #e6f7ee; color: #147a4b; font-size: 12px; font-weight: 600; }
dl { display: grid; grid-template-columns: 150px 1fr; gap: 10px 16px; margin: 22px 0; }
dt { color: #5b6b82; font-size: 13px; }
dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
code { background: #eef3fa; padding: 2px 6px; border-radius: 5px; }
.note { padding: 12px 14px; border-radius: 10px; background: #f0f6ff; color: #27456f; font-size: 13px; }
@media (prefers-color-scheme: dark) { body { background: #0d1420; color: #e6edf7; } main { background: #151f2e; box-shadow: none; } p, dt { color: #9babc2; } .badge { background: #123a2a; color: #72e4ad; } .note { background: #17263b; color: #c1d4ef; } code { background: #202e42; } }
</style>
</head>
<body>
<main>
  <span class="badge">RUNNING</span>
  <h1>WireGuard control panel</h1>
  <p>This machine is running a DSH WireGuard server. Open the WireGuard panel in a DSH client, choose <strong>Client</strong>, and enter this server's address.</p>
  <dl>
    <dt>Control address</dt><dd><code>${control}</code></dd>
    <dt>WireGuard endpoint</dt><dd>${endpoint}</dd>
    <dt>VPN subnet</dt><dd>${escapeHtml(info.vpnCidr ?? '')}</dd>
    <dt>Server public key</dt><dd>${escapeHtml(info.publicKey ?? '')}</dd>
    <dt>Connected peers</dt><dd>${peers.length}</dd>
    <dt>Join code</dt><dd>${info.joinRequired ? 'required — ask the server operator' : 'not required on this LAN'}</dd>
  </dl>
  <div class="note">Client address example: <code>${endpoint}</code> in the Client tab. The control panel is intentionally reachable only on the local network and exposes no private key.</div>
</main>
</body>
</html>`;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(html);
  }
}
