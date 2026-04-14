export class ConceptCardHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/ws/concept-cards') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.sockets.add(server);
      const cleanup = () => this.sockets.delete(server);
      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST' && url.pathname === '/broadcast') {
      let body;
      try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
      const msg = JSON.stringify(body);
      const dead = [];
      for (const socket of this.sockets) {
        try {
          socket.send(msg);
        } catch {
          dead.push(socket);
        }
      }
      dead.forEach(sock => this.sockets.delete(sock));
      return new Response(JSON.stringify({ ok: true, sent: this.sockets.size }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      (request.method === 'GET' && url.pathname === '/ws/concept-cards') ||
      (request.method === 'POST' && url.pathname === '/broadcast')
    ) {
      const id = env.CONCEPT_CARD_HUB.idFromName('singleton');
      const stub = env.CONCEPT_CARD_HUB.get(id);
      return stub.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  }
};
