import { redactSecretPatterns } from '../core/verification.mjs';

const MAX_REQUEST_ID = 200;

function assertFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new Error(`Invalid ${label} field: ${key}`);
}

function safeRequestId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_REQUEST_ID || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error('Invalid Master requestId');
  }
  return value;
}

function errorStatus(error) {
  const message = String(error?.message || error || 'Master chat request failed');
  if (/not found/i.test(message)) return 404;
  if (/already|outcome unknown|consumed|expired|changed or became unavailable|already in use/i.test(message)) return 409;
  if (/required|invalid|unsupported|must |only |limit|too many|preview is missing|secret-like|not available/i.test(message)) return 400;
  return 500;
}

export function createMasterChatHttpHandler({ masterChat, store, master, readBody, sendJson, securityHeaders }) {
  if (!masterChat || !store || !master || !readBody || !sendJson) throw new Error('Master chat HTTP handler requires the existing Dashboard services');

  function conversationIdFrom(pathname) {
    const match = pathname.match(/^\/api\/master\/conversations\/([^/]+)\/chat(?:\/|$)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function reply(response, status, value) {
    sendJson(response, status, value);
    return true;
  }

  async function route(request, response, url) {
    const conversationId = conversationIdFrom(url.pathname);
    if (!conversationId) return false;
    const suffix = url.pathname.slice(`/api/master/conversations/${encodeURIComponent(conversationId)}/chat`.length);

    try {
      if (suffix === '' && request.method === 'GET') {
        return reply(response, 200, await masterChat.metadata(conversationId));
      }

      if (suffix === '/context/preview' && request.method === 'POST') {
        const input = await readBody(request);
        assertFields(input, new Set(['refs']), 'Master context preview');
        if (!Array.isArray(input.refs)) throw new Error('Master context preview requires refs');
        return reply(response, 200, await masterChat.configure(conversationId, { contextRefs: input.refs }));
      }

      if (suffix === '/model' && request.method === 'PUT') {
        const input = await readBody(request);
        assertFields(input, new Set(['model']), 'Master chat model');
        if (input.model !== null && typeof input.model !== 'string') throw new Error('Master chat model must be a string or null');
        return reply(response, 200, await masterChat.configure(conversationId, { model: input.model }));
      }

      if (suffix === '/turns' && request.method === 'POST') {
        const input = await readBody(request);
        assertFields(input, new Set(['content', 'requestId', 'contextRefs', 'contextPreviewId', 'mode']), 'Master chat turn');
        if (input.mode !== 'plan') throw new Error('Master chat supports plan mode only');
        if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 8_000) throw new Error('Master chat content must contain 1 to 8000 characters');
        const requestId = safeRequestId(input.requestId);
        const contextRefs = input.contextRefs === undefined ? [] : input.contextRefs;
        if (!Array.isArray(contextRefs)) throw new Error('Master context refs must be an array');
        if (input.contextPreviewId !== undefined && (typeof input.contextPreviewId !== 'string' || input.contextPreviewId.length > 100)) {
          throw new Error('Invalid Master context preview ID');
        }

        const abortController = new AbortController();
        let settled = false;
        const abort = () => { if (!settled && !abortController.signal.aborted) abortController.abort(); };
        request.once('aborted', abort);
        response.once('close', abort);
        let terminalSent = false;
        response.writeHead(200, {
          ...securityHeaders,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const send = (event) => {
          if (response.writableEnded || response.destroyed) return;
          if (event?.type === 'error' || event?.type === 'done') terminalSent = true;
          const safeEvent = event?.type === 'error'
            ? { ...event, error: redactSecretPatterns(String(event.error || 'Master turn failed')).slice(0, 1_000) }
            : event;
          response.write(`data: ${JSON.stringify(safeEvent)}\n\n`);
        };
        try {
          await masterChat.turn(conversationId, input.content, {
            requestId,
            contextRefs,
            contextPreviewId: input.contextPreviewId,
            onEvent: send,
            abortSignal: abortController.signal,
          });
        } catch (error) {
          if (!terminalSent) send({ type: 'error', error: redactSecretPatterns(String(error?.message || error || 'Master turn failed')).slice(0, 1_000) });
        } finally {
          settled = true;
          request.off('aborted', abort);
          response.off('close', abort);
          if (!response.writableEnded && !response.destroyed) {
            response.write('data: [DONE]\n\n');
            response.end();
          }
        }
        return true;
      }

      const proposalRoute = suffix.match(/^\/proposals\/([^/]+)\/(execute|dismiss)$/);
      if (proposalRoute && request.method === 'POST') {
        const proposalId = decodeURIComponent(proposalRoute[1]);
        const input = await readBody(request);
        assertFields(input, new Set(), 'Master proposal action');
        const result = proposalRoute[2] === 'execute'
          ? await masterChat.executeProposal(conversationId, proposalId)
          : await masterChat.dismissProposal(conversationId, proposalId);
        return reply(response, 200, result);
      }
      return false;
    } catch (error) {
      const message = redactSecretPatterns(String(error?.message || error || 'Master chat request failed')).replace(/[\r\n\0]/g, ' ').slice(0, 1_000);
      return reply(response, errorStatus(error), { error: message });
    }
  }

  return { route };
}
