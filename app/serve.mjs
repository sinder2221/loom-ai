import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const types = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
};
const assets = [
  "index.html", "loom.css", "project-setup.css", "main.mjs",
  "activity.mjs", "chat-details.mjs", "demo-data.mjs", "edit-result.mjs", "edit-result-view.mjs", "fixtures.mjs",
  "usage.mjs", "usage-card.mjs", "usage-fixtures.json", "wizard.mjs", "wizard-view.mjs",
];

createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const asset = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!assets.includes(asset)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(asset, import.meta.url));
    response.writeHead(200, { "Content-Type": types[asset.split(".").at(-1)] }).end(body);
  } catch {
    response.writeHead(500).end();
  }
}).listen(4173, "127.0.0.1", () => {
  console.log("Project Loom fixture preview: http://127.0.0.1:4173");
});
