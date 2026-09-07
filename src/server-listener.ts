import type { Server } from "node:http";

import type { Express } from "express";

export function listenForRequests(app: Express, port: number, onListening: () => void): Server {
  return app.listen(port, "0.0.0.0", onListening);
}
