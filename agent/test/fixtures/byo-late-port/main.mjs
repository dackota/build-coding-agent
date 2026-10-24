// A byo image that breaks rule 3 on purpose: /readyz answers before the gRPC port is open.
import { createServer as net } from "node:net";
import { createServer as http } from "node:http";

const grpcPort = Number(process.env.KAGENT_PORT);
const readyzPort = Number(process.env.KAGENT_READYZ_PORT);
http((_req, res) => res.writeHead(200).end("ok")).listen(readyzPort, "0.0.0.0");
setTimeout(() => net((s) => s.destroy()).listen(grpcPort, "0.0.0.0"), 1500);
