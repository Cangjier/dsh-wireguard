/** Same-origin Host API consumed by the WireGuard panel. */

import { API_PREFIX, MAX_REQUEST_BYTES } from './constants';
import { WireGuardError } from './errors';

const AGENT_HEADER = 'x-dsh-wireguard';

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} value
 * @returns {void}
 */
function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

/**
 * Read a bounded JSON body.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new WireGuardError('request_too_large', 'Request body is too large.', { status: 413 });
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
 * Register the panel's local HTTP API on the Harness web server.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {import('./service').WireGuardService} service service instance.
 * @returns {void}
 */
export function registerHttpApi(ctx, service) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        const method = request.method ?? 'GET';
        const url = new URL(request.url ?? '/', 'http://local.invalid');
        const path = url.pathname;

        if (method === 'GET' && path === `${API_PREFIX}/state`) {
          writeJson(response, 200, { ok: true, state: await service.getState() });
          return;
        }
        if (method === 'GET' && path === `${API_PREFIX}/health`) {
          writeJson(response, 200, { ok: true, service: 'dsh-wireguard' });
          return;
        }
        if (method !== 'POST') {
          writeJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET or POST.' } });
          return;
        }
        if (request.headers[AGENT_HEADER] !== '1') {
          writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'Missing the local WireGuard request header.' } });
          return;
        }
        const body = await readJson(request);
        let result;
        if (path === `${API_PREFIX}/install`) result = await service.installWireGuard();
        else if (path === `${API_PREFIX}/server/start`) result = await service.startServer(body);
        else if (path === `${API_PREFIX}/server/stop`) result = await service.stopServer();
        else if (path === `${API_PREFIX}/peers/remove`) result = await service.removePeer(String(body.publicKey ?? ''));
        else if (path === `${API_PREFIX}/client/connect`) result = await service.connectClient(body);
        else if (path === `${API_PREFIX}/client/retry`) result = await service.retryClient();
        else if (path === `${API_PREFIX}/client/disconnect`) result = await service.disconnectClient();
        else if (path === `${API_PREFIX}/refresh`) result = await service.getState({ force: true });
        else {
          writeJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown WireGuard endpoint.' } });
          return;
        }
        writeJson(response, 200, { ok: true, state: result });
      } catch (error) {
        const state = service.snapshot();
        if (error instanceof WireGuardError) {
          writeJson(response, error.status, { ok: false, error: error.toJSON(), state });
          return;
        }
        writeJson(response, 500, {
          ok: false,
          error: {
            code: 'internal_error',
            message: error instanceof Error ? error.message : 'The WireGuard operation failed.',
          },
          state,
        });
      }
    },
  }), 'wireguard local api');
}
