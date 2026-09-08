# Building OpenCode for Windows 9x / 32-bit x86 (win9x)

This documents the end-to-end setup for building OpenCode as a **win32 x86** standalone
binary (`bun build --compile` targeting `bun-windows-x86`) using the win9x Bun. It covers
every fork and change involved, and how to reproduce the build.

> Status: the win9x binary builds, runs, and renders its OpenTUI interface on a 32-bit
> Windows host. Native OpenTUI rendering (`opentui.dll`, 32-bit) is embedded and loaded.

---

## Repos involved

| Repo | Location | Fork | Role |
| --- | --- | --- | --- |
| `bun` | `D:\WS\Bun` | local (win9x) | win9x-compatible Bun (i586, XP/9x-capable) |
| `opentui` | `D:\WS\opentui` | `guilt/opentui` | TUI render library; added win32-x86 native support |
| `opencode` | `D:\WS\OpenCode` | `guilt/opencode` | This repo |

The OpenTUI fork (`guilt/opentui`, branch `main`) carries the 32-bit x86 fixes; OpenCode
pins `@opentui/*` to `0.5.10` via `overrides` pointing at locally-packed fork tarballs.

---

## 1. The win9x Bun

Built from `D:\WS\Bun` with `scripts/build.ts`, profile `win9x-release` (and
`win9x-debug --asan=true` for the AddressSanitizer diagnostics build). Key properties:

- **Target:** `i586-pc-windows-msvc`, 32-bit PE (`coff-i386`), static CRT, no JIT (C loop).
- **`/LARGEADDRESSAWARE`** and an 18 MB `/STACK` reserve.
- **XP/9x-compatible syscalls** via `src/jsc/bindings/xp_compat.cpp`,
  `win9x_apiset_stubs.cpp`, `wsapoll_stub.cpp` (stub / `GetCurrentThreadStackLimits`,
  `SetThreadDescription`, etc.).
- **ASAN (diagnostic):** `win9x-debug --asan=true` links with MSVC `link.exe` (see below).

### 32-bit bug classes fixed in Bun

These are committed on the Bun branch and are the reason the win9x build works:

- **`usize` overflow on 32-bit** (`src/install/npm.rs`): a millisecond epoch timestamp was
  cast to `usize` (u32 on i586) → `TryFromIntError` panic on a background thread during
  module resolution. Fixed by keeping the timestamp in `u64`.
- **ZigString tagged-pointer corruption** (`src/bun_alloc/lib.rs` + all `jsc/bindings`
  string helpers): on 32-bit the pointer-tag bits (29–31) collide with real heap addresses
  above 512 MB, so `untag()` truncated pointers and produced garbage strings. Fixed by
  storing the string-kind flags in a separate `ZigString.flags` field on 32-bit.
- **node:path use-after-free** (earlier): `dirname`/`basename`/etc. now clone instead of
  borrowing (`to_slice_clone`).
- **CJS loader stack limits**: `GetCurrentThreadStackLimits` returns the *reserved* stack
  bounds (via `VirtualQuery`), not the committed region, so deep requires don't overflow.
- **bun:ffi 32-bit thunk libcalls** (`src/runtime/ffi/ffi_body.rs`): bun:ffi compiles call
  thunks with TinyCC. On i586 the thunks lower 64-bit ops to compiler-rt libcalls — e.g.
  `JSVALUE_TO_INT64`/`JSVALUE_TO_UINT64` in `FFI.h` cast `(int64_t)JSVALUE_TO_DOUBLE(...)`,
  which TCC emits as `__fixdfdi`/`__fixunsdfdi` (and `__floatdidf` for i64 returns, plus
  `memmove` for struct copies). `CompilerRT::inject` only registered symbols on x86_64, so
  `dlopen` of any library whose signatures contain `f64`/`i64` failed with
  `unresolved reference to '__fixdfdi'` (this is what broke OpenTUI's render library load).
  Fixed by registering the 64-bit compiler-rt helpers (`__fixdfdi`, `__fixunsdfdi`,
  `__floatdidf`, `__floatundidf`, `__muldi3`, `__udivdi3`, `__divdi3`, `__umoddi3`,
  `__moddi3`, `__ashldi3`, `__ashrdi3`, `__lshrdi3`) and `memmove` in the TCC symbol table
  on x86, mirroring the existing `memset`/`memcpy`/`JSVALUE_TO_INT64_SLOW` pattern.

### ASAN on win9x

`win9x-debug --asan=true` is a working AddressSanitizer build for finding heap bugs:

- ICU's common/i18n static libs are compiled with **clang-cl** (same flags as the rest of
  the build) so every object carries the same MSVC-STL ASAN annotations.
- The final link uses **MSVC `link.exe`** instead of `lld-link`, because clang-cl's ASAN
  instruments the MSVC STL (`annotate_string=1`, `stl_asan.lib`) and `lld-link` hard-errors
  on the resulting `std::ios_base::flags was replaced` ABI conflict. `cfg.useMsvcLink`
  switches the link rule; `link.exe` treats it as a non-fatal `LNK4006`.
- ASAN **global redzones are disabled** (`-mllvm -asan-globals=0` on C/C++,
  `-Cllvm-args=-asan-globals=0` on Rust): Bun stores embedded JS module strings as adjacent
  globals, so a legitimate cross-global read is falsely reported as `global-buffer-overflow`.
- The i586 ASAN runtime is MSVC-bundled; `scripts/build/deps/asan.ts` mirrors the clang
  resource dir and copies the runtime into `<buildDir>/clang-rt-i586`.

---

## 2. The OpenTUI fork (`guilt/opentui`)

OpenTUI's native render library (`libopentui`) is written in **Zig** and shipped per-platform
as `@opentui/core-<platform>-<arch>` packages (e.g. `@opentui/core-win32-x64`). There was no
32-bit Windows build, and `@opentui/core`'s `getNativeAssetDescriptor` rejected `x86`.

The fork adds 32-bit `win32-x86` support:

- **`packages/native/build.zig`**
  - Added `x86-windows-gnu` to the supported target matrix.
  - libwebp SSE2 dispatch is now compiled for 32-bit x86 too (needs `-msse2`, since SSE2 is
    not the i386 baseline) — fixes the undefined `VP8DspInitSSE2` etc. symbols.
- **`packages/native/src/audio.zig`**
  - 32-bit x86 has no `u64` atomics (`@atomicRmw`/`@atomicLoad` reject u64), so the
    diagnostic frame/byte counters are `u32` atomics (wrap at ~4.3 billion — infeasible for
    a session) and are widened to the `u64` extern-struct fields on snapshot.
- **`packages/core/src/node-asset-target.ts`**
  - Accepts `x86` as a native asset arch → resolves `@opentui/core-win32-x86/opentui.dll`.
- **`packages/core/package.json`** — `@opentui/core-win32-x86` added to `optionalDependencies`.

### Building the 32-bit native library

The native build pins **Zig 0.16.0** (`.zig-version`). Use the x86_64 host Zig (the 32-bit
host Zig has a build-system bug on 32-bit) — it cross-compiles fine:

```sh
cd packages/native
# deps (uucode, yoga, ghostty) ship in src/vendor/zig-deps.tar.gz; extracted by:
sh scripts/prepare-zig-deps.sh
# build 32-bit Windows DLL (ReleaseFast):
zig build -Dlibrary-target=x86-windows-gnu -Doptimize=ReleaseFast
# → packages/native/lib/x86-windows-gnu/opentui.dll  (coff-i386)
```

### Packaging the fork for OpenCode

OpenCode's `overrides` point at locally-packed fork tarballs. Rebuild them from the fork:

```sh
# JS packages
bun install                                        # at the opentui repo root
(cd packages/core && bun run build:lib)            # builds dist/
(cd packages/solid && bun run build)
(cd packages/keymap && bun run build)

# win32-x86 native package (DLL + index files), see packages/core/scripts/build.ts --native
mkdir -p packages/core/node_modules/@opentui/core-win32-x86
cp packages/native/lib/x86-windows-gnu/opentui.dll packages/core/node_modules/@opentui/core-win32-x86/

# pack publish-style tarballs (from each package's `dist`, so the compiled
# exports are used — NOT the `src/` exports in the source package.json, which
# fail opencode's stricter tsconfig)
bun pm pack --destination dist-tarballs            # from packages/core/dist
bun pm pack --destination dist-tarballs            # from packages/core/node_modules/@opentui/core-win32-x86
bun pm pack --destination dist-tarballs            # from packages/solid/dist, packages/keymap/dist
# (if bun pm pack rejects workspace:* devDeps, replace them with the version first)
```

The `dist-tarballs/` directory is expected at `D:\WS\opentui\dist-tarballs` (mirrored by the
`file:../opentui/dist-tarballs/*.tgz` overrides in this repo's `package.json`).

---

## 3. The OpenCode build

### Dependency wiring

`package.json` (root):

- The `catalog` pins `@opentui/*` to `0.5.10`.
- `overrides` redirect the four packages to the local fork tarballs:
  `@opentui/core`, `@opentui/core-win32-x86`, `@opentui/keymap`, `@opentui/solid`.
- `bun install` resolves them into `node_modules/.bun`.

The fork core is consumed from its **compiled `dist`** (publish-style package.json), not its
`src/`, so opencode's stricter `tsconfig` (`noImplicitOverride`) doesn't choke on the source.

### The win9x build script

`packages/opencode/script/build-win9x.ts` is **gitignored** (`script/build-*.ts`) — it is a
local, machine-specific script. It runs `Bun.build` with:

- `compile.target = "bun-windows-x86"` (win9x standalone).
- The OpenTUI Solid transform plugin (`@opentui/solid/bun-plugin`) for `.tsx`.
- `external: ["node-gyp", "@ff-labs/fff-bin-win32-x86"]` — FFF does **not** publish a
  32-bit Windows binary (npm 404), so `@ff-labs/fff-bun`'s `importFile` try/catch degrades
  gracefully instead of the bundler hard-failing.
- The tree-sitter worker entrypoint uses the **virtual** `files:` path
  (`opentui-tree-sitter-worker.js`), not a real file path.

```sh
cd packages/opencode
D:\WS\Bun\build\release-i586\bun.exe script/build-win9x.ts
# → dist/opencode-windows-x86/bin/opencode.exe  (coff-i386, ~139 MB)
```

### Known upstream gap: FFF native library

`@ff-labs/fff-bin-win32-x86` does not exist (FFF ships only x64/arm64). The win9x binary
runs without it (graceful fallback in `@ff-labs/fff-bun`); FFF-backed features will be
unavailable until FFF publishes 32-bit Windows binaries.

---

## 4. Verifying

```sh
dist/opencode-windows-x86/bin/opencode.exe --version   # 0.0.0-win9x
dist/opencode-windows-x86/bin/opencode.exe --help      # renders the OpenTUI banner
```

If the OpenTUI render library fails to load you'll see
`Failed to initialize OpenTUI render library: Unsupported OpenTUI Node asset target: win32-x86`
— that means the fork tarballs / win32-x86 native package aren't wired up (see §2–§3).