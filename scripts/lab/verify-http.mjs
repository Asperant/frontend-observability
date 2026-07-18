import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

import { caCertPath } from "./common.mjs";

/**
 * A real TLS chain validation against our own lab CA (not
 * rejectUnauthorized: false) — a genuine handshake, not a skipped one.
 */
export function requestHttps(
  path,
  { method = "GET", host = "127.0.0.1", port = 8443, headers = {}, body } = {},
) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method,
        host,
        port,
        path,
        headers,
        ca: readFileSync(caCertPath),
        servername: "localhost",
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (body) req.write(body);
    req.end();
  });
}

export function requestHttp(
  path,
  { method = "GET", host = "127.0.0.1", port = 5080, headers = {}, body } = {},
) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ method, host, port, path, headers, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (body) req.write(body);
    req.end();
  });
}
