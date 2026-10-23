import { createWriteStream } from 'node:fs';
import { redactSecretPatterns } from '../server/core/verification.mjs';

export function attachBetaProcessLog(child, file, prefix, { secrets = [] } = {}) {
  const stream = createWriteStream(file, { flags: 'a' });
  function write(value) {
    let text = String(value).replace(/server password[^\r\n]*/gi, 'server password [REDACTED]');
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    stream.write(redactSecretPatterns(text));
  }
  const flush = [child.stdout, child.stderr].filter(Boolean).map((input) => {
    let pending = '';
    let omitted = false;
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end + 1);
        if (omitted || line.length > 65_536) write('[oversized process log line omitted]\n');
        else write(line);
        pending = pending.slice(end + 1);
        omitted = false;
      }
      if (pending.length > 65_536) { pending = ''; omitted = true; }
    });
    return () => {
      if (omitted) write('[oversized process log line omitted]\n');
      else if (pending) write(pending);
    };
  });
  // close follows stdio drainage; exit alone may still have unread output.
  child.once('close', (code, signal) => {
    for (const finish of flush) finish();
    write(`\n[${prefix} exit code=${code} signal=${signal}]\n`);
    stream.end();
  });
  return stream;
}
