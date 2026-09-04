import { isLoopbackHost } from '../mcp/profiles.mjs';

export function dashboardBindConfiguration(env = process.env) {
  const host = String(env.AI_DASHBOARD_HOST || '127.0.0.1').trim();
  if (!isLoopbackHost(host)) {
    throw new Error('AI Dashboard refuses non-loopback binds until authentication, authorization and audit are implemented');
  }
  const rawPort = env.PORT || env.AI_DASHBOARD_PORT || 7331;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('AI Dashboard port must be an integer from 1 to 65535');
  return { host, port, privateMode: true };
}
