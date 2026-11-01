/**
 * Gives every relative import in the emitted declarations an explicit
 * extension, as ESM requires: `./client` becomes `./client.js`, and
 * `./contract` becomes `./contract/index.js`. The source keeps extensionless
 * imports, which every bundler in the workspace resolves; a consumer on
 * Node's `NodeNext` resolution needs them spelled out.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdout } from "node:process";

const dist = resolve(import.meta.dirname, "..", "dist");
// `from "./x"`, `import("./x")`, and `export … from "./x"`.
const specifier = /((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

let rewritten = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".d.ts")) fix(path);
  }
};

function fix(file) {
  const text = readFileSync(file, "utf8");
  const out = text.replace(specifier, (whole, lead, quote, spec) => {
    if (/\.(js|json)$/.test(spec)) return whole;
    const target = resolve(dirname(file), spec);
    let next;
    if (existsSync(`${target}.d.ts`)) next = `${spec}.js`;
    else if (existsSync(join(target, "index.d.ts")))
      next = `${spec.replace(/\/$/, "")}/index.js`;
    else throw new Error(`${file}: cannot resolve ${spec}`);
    rewritten += 1;
    return `${lead}${quote}${next}${quote}`;
  });
  if (out !== text) writeFileSync(file, out);
}

walk(dist);
stdout.write(`declarations: ${rewritten} relative imports given extensions\n`);
