#!/usr/bin/env bun

// win9x / 32-bit Windows build of the opencode binary.
//
// This is a single-target variant of build.ts for the win9x Bun:
//   - compile.target = "bun-windows-x86" (i586 standalone, subsystem 5.01)
//   - @ff-labs/fff-bin-win32-x86 does not exist on npm (FFF ships only
//     x64/arm64), so it is marked external and @ff-labs/fff-bun's importFile
//     try/catch degrades gracefully at runtime.
//   - the tree-sitter worker is registered under its virtual files: name
//     (opentui-tree-sitter-worker.js), not a real path on disk.
//
// Run with the win9x Bun from packages/opencode:
//   D:\WS\Bun\build\release-i586\bun.exe script/build-win9x.ts
// → dist/opencode-windows-x86/bin/opencode.exe
//
// Kept in git (force-added despite script/build-*.ts ignore) so `git clean`
// cannot take it again — see BUILD_WIN9X.md.

import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"

const sourcemapsFlag = process.argv.includes("--sourcemaps")
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const plugin = createSolidTransformPlugin()

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await Bun.$`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const name = "opencode-windows-x86"

await Bun.$`rm -rf dist`
await Bun.$`mkdir -p dist/${name}/bin`

const workerPath = "./src/cli/tui/worker.ts"
const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
const bunfsRoot = "B:/~BUN/root/"

await Bun.build({
  conditions: ["bun", "node"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  external: ["node-gyp", "@ff-labs/fff-bin-win32-x86"],
  format: "esm",
  minify: true,
  sourcemap: sourcemapsFlag ? "linked" : "none",
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: "bun-windows-x86" as any,
    outfile: `dist/${name}/bin/opencode`,
    execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
    windows: {},
  },
  files: {
    [treeSitterWorkerPath]: treeSitterWorker,
    ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
  },
  entrypoints: [
    "./src/index.ts",
    workerPath,
    treeSitterWorkerPath,
    ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
  ],
  define: {
    FFF_LIBC: JSON.stringify("gnu"),
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_MODELS_DEV: generated.modelsData,
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    OPENCODE_LIBC: "",
  },
})

console.log(`Built dist/${name}/bin/opencode.exe`)
