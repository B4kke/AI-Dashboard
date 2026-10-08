export class EventHub {
  #clients = new Set();
  #pings = new Map();

  #remove(response) {
    const ping = this.#pings.get(response);
    if (ping) clearInterval(ping);
    this.#pings.delete(response);
    this.#clients.delete(response);
  }

  #write(response, message) {
    if (!response || response.destroyed || response.writableEnded) {
      this.#remove(response);
      return false;
    }
    try {
      const accepted = response.write(message);
      if (accepted === false) {
        // A permanently slow SSE client must not grow the control plane's writable buffer without bound.
        this.#remove(response);
        response.end?.();
        return false;
      }
      return true;
    } catch {
      this.#remove(response);
      try { response.destroy?.(); } catch {}
      return false;
    }
  }

  subscribe(response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.#clients.add(response);
    this.#write(response, ': connected\n\n');
    if (!this.#clients.has(response)) return;

    const ping = setInterval(() => this.#write(response, ': ping\n\n'), 25_000);
    ping.unref?.();
    this.#pings.set(response, ping);
    const cleanup = () => this.#remove(response);
    response.once('close', cleanup);
    response.once('error', cleanup);
  }

  publish(type, payload = {}) {
    const message = `event: ${type}\ndata: ${JSON.stringify({ type, payload, at: new Date().toISOString() })}\n\n`;
    for (const client of [...this.#clients]) this.#write(client, message);
  }

  get clientCount() {
    return this.#clients.size;
  }
}
