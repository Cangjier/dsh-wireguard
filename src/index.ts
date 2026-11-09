/** Host entry for the WireGuard mesh plugin. */

import { homedir } from 'node:os';
import path from 'node:path';
import { registerHttpApi } from './lib/http-api';
import { WireGuardService } from './lib/service';

export const inject = ['webServer'];

/**
 * Resolve the durable plugin directory below the Harness home.
 * @returns {string} absolute directory.
 */
function dataDirectory() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : path.join(homedir(), '.dsh');
  return path.join(home, 'wireguard');
}

/**
 * Activate the Host service and its same-origin panel API.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {Record<string, unknown>} [config] bundle row configuration.
 * @returns {Promise<void>}
 */
export async function apply(ctx, config = {}) {
  const service = new WireGuardService({
    config,
    dataDir: dataDirectory(),
    log: (line) => console.log(line),
  });
  ctx.effect(() => () => {
    void service.dispose();
  }, 'wireguard service lifetime');
  await service.init();
  registerHttpApi(ctx, service);
}
