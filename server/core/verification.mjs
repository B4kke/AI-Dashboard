import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FORBIDDEN = /[\u0000-\u001f\u007f|&;<>`$(){}]/;
const SECRET_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH(?:ORIZATION)?|CREDENTIAL)/i;

export function parseVerificationCommand(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('Verification command is empty');
  if (FORBIDDEN.test(input)) throw new Error('Verification command contains shell/control syntax');
  const parts = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) { parts.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error('Verification command has an unterminated quote');
  if (current) parts.push(current);
  if (!parts.length) throw new Error('Verification command is empty');
  if (parts[0].startsWith('-')) throw new Error('Verification executable cannot begin with -');
  return { command: parts[0], args: parts.slice(1), display: input };
}

function redactSecretPatterns(value, env = process.env) {
  let text = String(value || '');
  for (const [name, secret] of Object.entries(env || {})) {
    if (!SECRET_ENV_NAME.test(name) || typeof secret !== 'string' || secret.length < 8) continue;
    text = text.split(secret).join('[REDACTED]');
  }
  text = text
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi, 'Bearer [REDACTED]');
  return text;
}

function bounded(value, limit = 12_000) {
  const text = redactSecretPatterns(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

export async function runVerificationCommands({ cwd, commands = [], timeoutMs = 120_000 }) {
  const results = [];
  for (const value of commands) {
    const parsed = typeof value === 'string'
      ? parseVerificationCommand(value)
      : { command: value?.command, args: Array.isArray(value?.args) ? value.args.map(String) : [], display: value?.display || [value?.command, ...(value?.args || [])].filter(Boolean).join(' ') };
    if (!parsed.command || parsed.command.startsWith('-')) throw new Error('Invalid verification executable');
    const startedAt = new Date().toISOString();
    const safeDisplay = bounded(parsed.display, 2_000);
    try {
      const { stdout, stderr } = await execFileAsync(parsed.command, parsed.args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CI: process.env.CI || '1', GIT_TERMINAL_PROMPT: '0' },
      });
      results.push({ command: safeDisplay, status: 'passed', exitCode: 0, stdout: bounded(stdout), stderr: bounded(stderr), startedAt, finishedAt: new Date().toISOString() });
    } catch (error) {
      results.push({
        command: safeDisplay,
        status: 'failed',
        exitCode: Number.isInteger(error.code) ? error.code : null,
        signal: error.signal || null,
        stdout: bounded(error.stdout),
        stderr: bounded(error.stderr || error.message),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    }
  }
  return {
    commands: results,
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    ok: results.length > 0 && results.every((item) => item.status === 'passed'),
  };
}

export { redactSecretPatterns };
