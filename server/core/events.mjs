export class EventHub {
  #clients = new Set();

  subscribe(response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(': connected\n\n');
    this.#clients.add(response);
    const ping = setInterval(() => response.write(': ping\n\n'), 25_000);
    response.on('close', () => {
      clearInterval(ping);
      this.#clients.delete(response);
    });
  }

  publish(type, payload = {}) {
    const message = `event: ${type}\ndata: ${JSON.stringify({ type, payload, at: new Date().toISOString() })}\n\n`;
    for (const client of this.#clients) client.write(message);
  }

  get clientCount() {
    return this.#clients.size;
  }
}
