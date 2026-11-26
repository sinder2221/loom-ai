import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { basename } from "node:path";

const config = JSON.parse(await readFile(new URL("./tauri.conf.json", import.meta.url), "utf8"));
const assets = config.build.frontendDist.filter((file) => file.startsWith("dist/"));
const dist = new URL("./dist/", import.meta.url);

await rm(dist, { force: true, recursive: true });
await mkdir(dist);
await Promise.all(assets.map((asset) => copyFile(
  new URL(`../app/${basename(asset)}`, import.meta.url),
  new URL(asset, import.meta.url),
)));
