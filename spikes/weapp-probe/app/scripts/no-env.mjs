// Taro/Vite may discover dotenv automatically. Block file contents before their loaders run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const blocked = (value) => {
  if (typeof value === "number") return false;
  const name = path.basename(value instanceof URL ? fileURLToPath(value) : String(value));
  return name === ".env" || name.startsWith(".env.");
};
const error = () => Object.assign(new Error("PROBE_ENV_FILE_BLOCKED"), { code: "ENOENT" });
const exists = fs.existsSync;
fs.existsSync = (value) => (blocked(value) ? false : exists(value));
for (const method of ["readFileSync", "openSync"]) {
  const original = fs[method];
  fs[method] = (value, ...args) => {
    if (blocked(value)) throw error();
    return original(value, ...args);
  };
}
for (const method of ["readFile", "open"]) {
  const original = fs[method];
  fs[method] = (value, ...args) => {
    if (blocked(value)) {
      const callback = args.at(-1);
      if (typeof callback === "function") return callback(error());
      throw error();
    }
    return original(value, ...args);
  };
  const originalPromise = fs.promises[method];
  fs.promises[method] = async (value, ...args) => {
    if (blocked(value)) throw error();
    return originalPromise(value, ...args);
  };
}
syncBuiltinESMExports();
