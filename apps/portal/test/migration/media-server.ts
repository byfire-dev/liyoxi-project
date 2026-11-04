import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FILE_CONTENT } from "./fixtures";

/** Browser-managed a[download] requests can bypass Playwright routing. This test-only,
 * ephemeral loopback server serves fixed fixture bytes, never a production file or API. */
export async function createFixtureMedia() {
  const names = new Map([
    ["/__migration-files__/episode", "migration-episode-1.mp4"],
    ["/__migration-files__/zip", "migration-package.zip"],
    ["/__migration-files__/publish_list", "migration-publish-list.txt"],
  ]);
  const unexpected: string[] = [];
  const server = createServer((request, response) => {
    const fileName = names.get(request.url ?? "");
    if (!fileName || request.method !== "GET") {
      unexpected.push(`${request.method} ${request.url}`);
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": Buffer.byteLength(FILE_CONTENT),
      "Cache-Control": "no-store",
    });
    response.end(FILE_CONTENT);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    unexpected,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
