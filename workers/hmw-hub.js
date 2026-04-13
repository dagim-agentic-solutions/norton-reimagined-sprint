// Durable Object: HmwHub
// Manages WebSocket connections for real-time HMW board sync

export class HmwHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/ws/hmw') {
      // WebSocket upgrade
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.sockets.add(server);

      server.addEventListener('close', () => {
        this.sockets.delete(server);
      });
      server.addEventListener('error', () => {
        this.sockets.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST' && url.pathname === '/broadcast-hmw') {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
      const msg = JSON.stringify(body);
      const dead = [];
      for (const socket of this.sockets) {
        try {
          socket.send(msg);
        } catch {
          dead.push(socket);
        }
      }
      for (const socket of dead) {
        this.sockets.delete(socket);
      }
      return new Response(JSON.stringify({ sent: this.sockets.size }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

// Default export for the worker entrypoint (routes to the DO)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      (request.method === 'GET' && url.pathname === '/ws/hmw') ||
      (request.method === 'POST' && url.pathname === '/broadcast-hmw')
    ) {
      const id = env.HMW_HUB.idFromName('singleton');
      const stub = env.HMW_HUB.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
