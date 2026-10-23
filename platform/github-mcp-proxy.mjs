// The GitHub MCP server's auth proxy. github-mcp-server's http mode wants a GitHub token on
// every request; this proxy, in the same pod, adds it from GITHUB_TOKEN (a Secret) and passes
// everything else through, streaming. The agent calls the proxy with no credential, so the
// token is in this pod only: never in the agent's config, env, or logs. Any Authorization the
// client sends is replaced, so a caller cannot act as someone else. The log has the method,
// path and status of each request, never a header.
// Env: GITHUB_TOKEN (required), UPSTREAM_URL (default http://127.0.0.1:8082), PORT (default 8080).
import { createServer, request } from "node:http";

const log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

const token = (process.env.GITHUB_TOKEN ?? "").trim();
if (!token) {
  log("no-token", { message: "GITHUB_TOKEN is empty or unset; refusing to start" });
  process.exit(1);
}
const upstream = new URL(process.env.UPSTREAM_URL ?? "http://127.0.0.1:8082");
const port = Number(process.env.PORT ?? 8080);
// Hop-by-hop headers belong to one connection and are not forwarded.
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"];

function forwardHeaders(incoming) {
  const headers = { ...incoming, host: upstream.host, authorization: `Bearer ${token}` };
  for (const name of HOP_BY_HOP) delete headers[name];
  return headers;
}

createServer((req, res) => {
  const upstreamReq = request(
    { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: forwardHeaders(req.headers) },
    (upstreamRes) => {
      log("request", { method: req.method, path: req.url, status: upstreamRes.statusCode });
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", (err) => {
    // err.message names the upstream address and the failure, never a header.
    log("upstream-failed", { method: req.method, path: req.url, message: err.message });
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("the GitHub MCP server is unavailable");
  });
  req.pipe(upstreamReq);
}).listen(port, () => log("listening", { port, upstream: upstream.origin }));
