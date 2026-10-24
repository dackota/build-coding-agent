import { createServer, type Server } from "node:http";

/** GET /readyz answers 200 as soon as the process runs. Uses only node:http, so it is up before the heavy imports. */
export function startReadyz(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/readyz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}
