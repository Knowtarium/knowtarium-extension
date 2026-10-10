// Packs the production build in dist/ for the stores: release/knowtarium-extension-chrome-<v>.zip
// (Chrome Web Store) and release/knowtarium-extension-edge-<v>.zip (Edge Add-ons), the same files
// from the same build, plus SHA256SUMS and size.json with the packed size for the release notes.
// Before packing it checks the build: a production manifest (no development key, the two
// permissions and nothing else, the CSP), no inline script and no eval. (vite.config.ts makes sure
// only the pinned standard libsodium build is bundled.)
// The zips are reproducible: entries sorted, fixed times and modes, so the same build gives the
// same bytes. Run it through `pnpm package`, which builds first.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const out = join(root, "release");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

function files(dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    })
    .sort();
}

// the build
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
if (manifest.version !== version) fail(`manifest version ${manifest.version} isn't ${version}`);
if ("key" in manifest) fail("the build has the development key: run `pnpm build` (production)");
if (manifest.name !== "Knowtarium Web Clipper") fail(`not a production build: ${manifest.name}`);
if (JSON.stringify(manifest.permissions) !== JSON.stringify(["activeTab", "storage"])) {
  fail(
    `permissions must be exactly activeTab and storage: ${JSON.stringify(manifest.permissions)}`,
  );
}
for (const key of [
  "host_permissions",
  "optional_permissions",
  "optional_host_permissions",
  "content_scripts",
  "externally_connectable",
  "web_accessible_resources",
]) {
  if (key in manifest) fail(`the manifest must not have ${key}`);
}
if (
  manifest.content_security_policy?.extension_pages !==
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
) {
  fail("the extension pages' CSP changed");
}

const all = files(dist);
for (const path of all) {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".html") && /<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) {
    fail(`${relative(dist, path)} has an inline script`);
  }
  if (path.endsWith(".js") && /\beval\(|\bnew Function\(/.test(text)) {
    fail(`${relative(dist, path)} calls eval`);
  }
}

// reproducible zips: sorted entries, 1980-01-01 00:00, mode 644, deflated
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function zip(paths) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const path of paths) {
    const name = Buffer.from(relative(dist, path).split(sep).join("/"), "utf8");
    const data = readFileSync(path);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(paths.length, 8);
  end.writeUInt16LE(paths.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const packed = zip(all);
const names = [
  `knowtarium-extension-chrome-${version}.zip`,
  `knowtarium-extension-edge-${version}.zip`,
];
for (const name of names) writeFileSync(join(out, name), packed);

const sums = names
  .map((name) => `${createHash("sha256").update(packed).digest("hex")}  ${name}`)
  .join("\n");
writeFileSync(join(out, "SHA256SUMS"), `${sums}\n`);

const unpacked = all.reduce((total, path) => total + statSync(path).size, 0);
const size = { version, packedBytes: packed.length, unpackedBytes: unpacked, files: all.length };
writeFileSync(join(out, "size.json"), `${JSON.stringify(size, null, 2)}\n`);

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(
  `Packed ${String(all.length)} files: ${kib(packed.length)} zipped, ${kib(unpacked)} unpacked`,
);
for (const name of names) console.log(`  release/${name}`);
console.log(sums);
