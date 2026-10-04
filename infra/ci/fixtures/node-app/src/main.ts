import { createServer } from "node:http";

const port = Number(process.env["PORT"] ?? 3100);

export const server = createServer((_request, response) => {
  response.writeHead(204).end();
});

export function start(): void {
  server.listen(port);
}
