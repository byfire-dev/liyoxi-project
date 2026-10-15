// W2-27b2a：仅分离本次构建的第一方产物；无上传、SDK、凭据或外部命令。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const definitions = {
  api: ["apps/api/dist", "server.js", "server"],
  worker: ["apps/worker/dist", "index.js", "server"],
  admin: ["apps/admin/dist/app", "index.html", "gateway"],
  portal: ["apps/portal/dist/app", "index.html", "gateway"],
  weapp: ["apps/weapp/dist", "app.js", "weapp-build"],
};
const COMPONENTS = Object.keys(definitions);
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const reference =
  /^[ \t]*(?:\/\/[#@][ \t]*sourceMappingURL=([^\s]+)|\/\*[#@][ \t]*sourceMappingURL=([^\s*]+)[ \t]*\*\/)[ \t]*$/gm;
const guard = (value) => {
  if (!value) throw new Error("source_maps_invalid");
};
function inside(root, name) {
  guard(typeof name === "string" && /^[A-Za-z0-9_./-]{1,512}$/.test(name));
  guard(!name.split("/").some((part) => !part || part === "." || part === ".."));
  const path = resolve(root, name);
  guard(path.startsWith(`${resolve(root)}${sep}`));
  return path;
}
async function regular(path, max = MAX_FILE) {
  const stat = await fs.lstat(path);
  guard(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= max);
  return stat;
}
async function json(path, max) {
  await regular(path, max);
  return JSON.parse(await fs.readFile(path, "utf8"));
}
async function digest(path) {
  const stat = await regular(path);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  })) {
    size += chunk.length;
    guard(size <= MAX_FILE);
    hash.update(chunk);
  }
  guard(size === stat.size);
  return { size, sha256: hash.digest("hex") };
}
async function writeJson(path, value) {
  await fs.writeFile(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
}
async function files(root, directory = root, found = []) {
  guard((await fs.lstat(directory)).isDirectory());
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    guard(!entry.isSymbolicLink() && found.length < 4096);
    const path = inside(root, relative(root, join(directory, entry.name)).split(sep).join("/"));
    if (entry.isDirectory()) await files(root, path, found);
    else {
      guard(entry.isFile());
      found.push(relative(root, path).split(sep).join("/"));
    }
  }
  return found.sort();
}
function cleanReference(text, map) {
  const matches = [...text.matchAll(reference)];
  guard(matches.length <= 1);
  if (!matches.length) return text;
  const match = matches[0];
  guard(
    (match[1] ?? match[2]) === basename(map) && !text.slice(match.index + match[0].length).trim(),
  );
  // 只移除终端引用，保留行/列，map仍对应发布的同一份JS前缀。
  return (
    text.slice(0, match.index) +
    " ".repeat(match[0].length) +
    text.slice(match.index + match[0].length)
  );
}
export async function split(component, repo, output, build) {
  guard(
    Object.hasOwn(definitions, component) &&
      typeof build === "string" &&
      /^[A-Za-z0-9._-]{1,64}$/.test(build),
  );
  const [directory, entry] = definitions[component];
  const root = resolve(repo, directory),
    out = resolve(output),
    target = join(out, component);
  guard(!(await fs.lstat(root)).isSymbolicLink());
  guard(!out.startsWith(`${root}${sep}`) && out !== root && !root.startsWith(`${out}${sep}`));
  const names = await files(root);
  guard(names.includes(entry));
  const maps = names.filter((name) => name.endsWith(".map"));
  guard(
    maps.length > 0 &&
      names.filter((name) => name.endsWith(".js")).every((name) => maps.includes(`${name}.map`)),
  );
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  guard(!(await fs.lstat(out)).isSymbolicLink() && (await fs.realpath(out)) === out);
  await fs.mkdir(target, { mode: 0o700 });
  const pairs = [];
  let total = 0;
  for (const name of maps) {
    const code = name.slice(0, -4),
      from = inside(root, code),
      map = inside(root, name);
    guard(names.includes(code));
    const parsed = await json(map, MAX_FILE);
    guard(
      parsed.version === 3 &&
        typeof parsed.mappings === "string" &&
        Array.isArray(parsed.sources) &&
        parsed.sources.length > 0 &&
        parsed.sources.every((one) => typeof one === "string"),
    );
    guard(parsed.file === undefined || basename(parsed.file) === basename(code));
    await regular(from);
    const cleaned = cleanReference(await fs.readFile(from, "utf8"), name);
    const dest = inside(target, code),
      destMap = inside(target, name);
    await fs.mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await fs.writeFile(dest, cleaned, { flag: "wx", mode: 0o600 });
    await fs.copyFile(map, destMap, constants.COPYFILE_EXCL);
    await fs.chmod(destMap, 0o600);
    const artifact = {
      path: code,
      ...(await digest(dest)),
      map: { path: name, ...(await digest(destMap)) },
    };
    total += artifact.size + artifact.map.size;
    guard(total <= MAX_TOTAL);
    pairs.push(artifact);
  }
  await writeJson(join(out, `${component}.json`), {
    schemaVersion: 1,
    component,
    build,
    files: pairs,
  });
  for (const pair of pairs) {
    await fs.copyFile(inside(target, pair.path), inside(root, pair.path));
    await fs.unlink(inside(root, pair.map.path));
  }
  guard(!(await files(root)).some((name) => name.endsWith(".map")));
  return { component, pairs: pairs.length };
}
export async function init(base) {
  const root = await fs.mkdtemp(join(await fs.realpath(base), "lyx-source-maps-"));
  await fs.chmod(root, 0o700);
  await writeJson(join(root, ".owner.json"), { schemaVersion: 1, root });
  return root;
}
async function owned(input) {
  const root = resolve(input);
  guard(
    /^lyx-source-maps-[A-Za-z0-9]{6}$/.test(basename(root)) &&
      !(await fs.lstat(root)).isSymbolicLink() &&
      (await fs.realpath(root)) === root,
  );
  const owner = await json(join(root, ".owner.json"), 1024);
  guard(owner.schemaVersion === 1 && owner.root === root && Object.keys(owner).length === 2);
  return root;
}
async function verifyPairs(root, component, fragment) {
  guard((await fs.realpath(root)) === root && !(await fs.lstat(root)).isSymbolicLink());
  guard(
    fragment.schemaVersion === 1 &&
      fragment.component === component &&
      Array.isArray(fragment.files) &&
      fragment.files.length > 0 &&
      fragment.files.length <= 4096,
  );
  const seen = new Set();
  let total = 0;
  for (const pair of fragment.files) {
    guard(pair.map?.path === `${pair.path}.map` && !seen.has(pair.path));
    seen.add(pair.path);
    for (const item of [pair, pair.map]) {
      const path = inside(root, item.path);
      for (let parent = dirname(path); parent !== root; parent = dirname(parent))
        guard(!(await fs.lstat(parent)).isSymbolicLink());
      const actual = await digest(path);
      guard(actual.size === item.size && actual.sha256 === item.sha256);
      total += actual.size;
      guard(total <= MAX_TOTAL);
    }
  }
}
function identity(source, tag) {
  guard(/^[a-f0-9]{40}$/.test(source) && tag === `sha-${source.slice(0, 12)}`);
}
async function imageFacts(root, source, tag) {
  const raw = await json(join(root, "images.json"), 1024 * 1024);
  guard(Array.isArray(raw) && raw.length === 2);
  const images = {};
  for (const name of ["server", "gateway"]) {
    const matches = raw.filter((image) => image.RepoTags?.includes(`liyoxi/${name}:${tag}`));
    guard(
      matches.length === 1 &&
        /^sha256:[a-f0-9]{64}$/.test(matches[0].Id) &&
        matches[0].Config?.Labels?.["org.opencontainers.image.revision"] === source,
    );
    images[name] = matches[0].Id;
  }
  return images;
}
export async function finalize(input, source, tag) {
  const root = await owned(input);
  identity(source, tag);
  const images = await imageFacts(root, source, tag),
    components = {};
  for (const component of COMPONENTS) {
    const base = join(root, definitions[component][2]);
    guard((await fs.realpath(base)) === base);
    const fragment = await json(join(base, `${component}.json`), 4 * 1024 * 1024);
    guard(fragment.build === tag);
    await verifyPairs(join(base, component), component, fragment);
    components[component] = fragment;
  }
  await writeJson(join(root, "manifest.json"), {
    schemaVersion: 1,
    source,
    tag,
    images,
    components,
    upload: "unimplemented",
  });
  return { components: COMPONENTS.length, upload: "unimplemented" };
}
export async function verify(input, source, tag) {
  const root = await owned(input),
    manifest = await json(join(root, "manifest.json"), 20 * 1024 * 1024);
  identity(source, tag);
  guard(
    manifest.schemaVersion === 1 &&
      manifest.source === source &&
      manifest.tag === tag &&
      manifest.upload === "unimplemented" &&
      Object.keys(manifest.components).sort().join() === [...COMPONENTS].sort().join(),
  );
  guard(JSON.stringify(manifest.images) === JSON.stringify(await imageFacts(root, source, tag)));
  for (const component of COMPONENTS) {
    guard(manifest.components[component].build === tag);
    await verifyPairs(
      join(root, definitions[component][2], component),
      component,
      manifest.components[component],
    );
  }
  return { components: COMPONENTS.length, upload: "unimplemented" };
}
export async function cleanup(input) {
  await fs.rm(await owned(input), { recursive: true });
}
async function main(args) {
  const [command, ...values] = args;
  const methods = {
    init: [init, 1],
    split: [split, 4],
    finalize: [finalize, 3],
    verify: [verify, 3],
    cleanup: [cleanup, 1],
  };
  guard(Object.hasOwn(methods, command) && values.length === methods[command][1]);
  const result = await methods[command][0](...values);
  if (result !== undefined)
    process.stdout.write(`${typeof result === "string" ? result : JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error("source-maps: rejected");
    process.exitCode = 1;
  });
}
