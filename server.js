#!/usr/bin/env node
// Claude Activity: a local dashboard for everything Claude Code does on this computer.
// No dependencies. Serves on http://127.0.0.1:4317 (CA_PORT to change). Local only.
const http = require("http");
const fs = require("fs");
const path = require("path");
const activity = require("./lib/activity");
const review = require("./lib/review");

const PORT = Number(process.env.CA_PORT) || 4317;
const HOST = process.env.CA_HOST || "127.0.0.1";
const PAGE = path.join(__dirname, "public", "index.html");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    // Only answer under a local hostname: stops DNS-rebinding pages from reading your data.
    if (HOST === "127.0.0.1" && !LOCAL_HOSTS.has(String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase())) {
      return json(res, 403, { error: "Unknown host" });
    }
    // Anything that does something (reviews, fixes) needs a header other websites can't send.
    if (req.method !== "GET" && req.headers["x-claude-activity"] !== "1") return json(res, 403, { error: "Missing X-Claude-Activity header" });

    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return fs.createReadStream(PAGE).pipe(res);
    }
    if (parts[0] !== "api" || parts[1] !== "claude") return json(res, 404, { error: "Not found" });
    const [, , what, id, action] = parts;

    if (req.method === "GET" && !what) {
      // Polled every 5 s: answer "not modified" unless something changed.
      const { body, etag } = activity.summaryResponse();
      const bare = (t) => String(t || "").replace(/^W\//, "").replace(/"/g, "");
      if (bare(req.headers["if-none-match"]) === bare(etag)) { res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" }); return res.end(); }
      res.writeHead(200, { "Content-Type": "application/json", ETag: etag, "Cache-Control": "no-cache" });
      return res.end(body);
    }
    if (req.method === "GET" && what === "code") {
      const edit = activity.codeEdit(decodeURIComponent(id || ""));
      return edit ? json(res, 200, edit) : json(res, 404, { error: "Not found" });
    }
    if (req.method === "GET" && what === "reviews") return json(res, 200, review.summary());
    if (req.method === "POST" && what === "review" && action === "accept") {
      const r = review.accept(decodeURIComponent(id || ""), ((await readBody(req)).items || []).map(Number));
      return json(res, r.error === "busy" ? 409 : r.error ? 400 : 202, r);
    }
    if (req.method === "POST" && what === "review") {
      const r = review.reviewNow(decodeURIComponent(id || ""));
      return json(res, r.error === "busy" ? 409 : r.error ? 400 : 202, r);
    }
    if (req.method === "POST" && what === "review-auto") return json(res, 200, review.setAuto((await readBody(req)).on));
    return json(res, 404, { error: "Not found" });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is in use. Set CA_PORT to use another.` : err.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  review.start();
  console.log(`Claude Activity: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});
