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
pins `@opentui/*` to `0.5.11` via `overrides` pointing at locally-packed fork tarballs.

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
- **bun:ffi JSValue encoding on 32-bit** (`src/runtime/ffi/FFI.h` + `ffi_body.rs` +
  `host_fns.rs`): the JSC port on 32-bit x86 is **USE_JSVALUE32_64** (64-bit box with a
  32-bit tag in the high word), but bun:ffi's FFI.h hardcoded USE_JSVALUE64 tags
  (`NumberTag 0xFFFE…`, `DoubleEncodeOffset 1<<49`). Every non-`void` FFI return was
  garbage — a `u32` return decoded as `NaN`, so `createEventSink`/`createTextBuffer` (and
  anything returning a small int32) failed while large values coincidentally round-tripped.
  Fixed by making FFI.h arch-aware (`BUN_FFI_JSVALUE32` is emitted by the thunk codegen):
  USE_JSVALUE32_64 tags (`Int32Tag 0xFFFFFFFF`, doubles stored as raw IEEE bits, cells
  tagged `0xFFFFFFFB`) for `INT32/DOUBLE/FLOAT/BOOL/PTR_TO_JSVALUE`, `JSVALUE_TO_*`, typed
  arrays, and the `ValueUndefined`/`ValueTrue` globals. Two 32-bit call-frame bugs fixed in
  the same pass: `size_t`/`intptr_t`/`uintptr_t` were typedef'd 64-bit (so
  `LOAD_ARGUMENTS_FROM_CALL_FRAME` read the argument list 24 bytes past its real start),
  and `Bun_FFI_PointerOffsetToArgumentsList` (6 words on x64) must be **10** `size_t`
  units on 32-bit (arg0 is at Register slot 5 × 8-byte slots).

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
  - On the **0.5.11** rebase, three `@atomicLoad(u64, &stream.bytes_received/frames_decoded)`
    reads were reintroduced upstream and must read the `u32` fields instead
    (`@as(u64, @atomicLoad(u32, ...))`).
- **`packages/core/src/node-asset-target.ts`**
  - Accepts `x86` as a native asset arch → resolves `@opentui/core-win32-x86/opentui.dll`.
- **`packages/core/package.json`** — `@opentui/core-win32-x86` added to `optionalDependencies`.

### Building the 32-bit native library (clean-tree recipe)

The native build pins **Zig 0.16.0** (`.zig-version`). Use the x86_64 host Zig (the 32-bit
host Zig has a build-system bug on 32-bit) — it cross-compiles fine. Required on PATH:
that Zig, **NASM** (`build.zig` assembles `src/win9x_imports.asm` via `nasm -f win32`), and
**GNU dlltool** (`D:\WS\EXTDEV\MinGW\x86\Bin\dlltool.exe` — NOT `lib.exe /def:`, see §5).

```sh
cd packages/native

# 1. deps (uucode, yoga, ghostty) ship in src/vendor/zig-deps.tar.gz; extracted by:
sh scripts/prepare-zig-deps.sh            # → zig-deps/{uucode-opentui,ghostty,yoga}

# 2. lib/ucrt_msvcrt.lib is a generated *link input* (build.zig does
#    addObjectFile for it on x86) that lives in the gitignored lib/ dir —
#    regenerate it whenever it is missing (a `git clean -fdx` deletes it):
mkdir -p lib
dlltool -d src\ucrt_msvcrt.def -l lib\ucrt_msvcrt.lib -m i386   # ~33 KB

# 3. build the 32-bit Windows DLL (ReleaseSafe is what we ship):
zig build -Dlibrary-target=x86-windows-gnu -Doptimize=ReleaseSafe
# → packages/native/lib/x86-windows/opentui.dll + opentui.pdb  (coff-i386)
#   NOTE: the output dir is lib/x86-windows/ — the -gnu ABI suffix is elided
#   in output_name; lib/x86-windows-gnu/ does not exist.
```

The zig build itself needs **no UCRT shim DLLs** — the `api-ms-win-crt-*` shims of §5 are
runtime-only (consumed when the built DLL is loaded on XP), never build inputs.

### Packaging the fork for OpenCode

OpenCode's `overrides` point at locally-packed fork tarballs. Rebuild them from the fork
(all four tarballs must carry **0.5.11** — OpenCode's `catalog` pins `@opentui/*` to
`0.5.11` and the overrides redirect them to these files):

```sh
bun install                                        # at the opentui repo root

# JS packages
(cd packages/core && bun run build:lib)            # builds dist/
(cd packages/solid && bun run build)
(cd packages/keymap && bun run build)

# win32-x86 native package: variants.ts includes { platform: "win32", arch: "x86" },
# so the staging step picks up lib/x86-windows/ and emits
# @opentui/core-win32-x86 (DLL + index files + licenses) at
# packages/core/node_modules/@opentui/core-win32-x86
(cd packages/core && bun scripts/build.ts --native --skip-zig --all --skip-symbols)

# pack publish-style tarballs (from each package's `dist`, so the compiled
# exports are used — NOT the `src/` exports in the source package.json, which
# fail opencode's stricter tsconfig)
bun pm pack --destination <repo-root>/dist-tarballs   # cwd: packages/core/dist
bun pm pack --destination <repo-root>/dist-tarballs   # cwd: packages/core/node_modules/@opentui/core-win32-x86
bun pm pack --destination <repo-root>/dist-tarballs   # cwd: packages/solid/dist
bun pm pack --destination <repo-root>/dist-tarballs   # cwd: packages/keymap/dist
# (if bun pm pack rejects `workspace:*` devDeps, replace them with "0.5.11"
#  in that dist/package.json first)

# rename the x86 tarball to the name OpenCode's override expects:
mv dist-tarballs/opentui-core-win32-x86-0.5.11.tgz dist-tarballs/opentui-core-win32-x86-511.tgz
```

The `dist-tarballs/` directory is expected at `D:\WS\opentui\dist-tarballs` (mirrored by the
`file:../opentui/dist-tarballs/*.tgz` overrides in this repo's `package.json`).

---

## 3. The OpenCode build

### Dependency wiring

`package.json` (root):

- The `catalog` pins `@opentui/*` to `0.5.11`.
- `overrides` redirect the four packages to the local fork tarballs:
  `@opentui/core`, `@opentui/core-win32-x86`, `@opentui/keymap`, `@opentui/solid`.
- `bun install` resolves them into `node_modules/.bun`.

The fork core is consumed from its **compiled `dist`** (publish-style package.json), not its
`src/`, so opencode's stricter `tsconfig` (`noImplicitOverride`) doesn't choke on the source.

### The win9x build script

`packages/opencode/script/build-win9x.ts` is **force-tracked in git** — it still matches
the `script/build-*.ts` ignore rule (so plain `git add` needs `-f`). It used to be
ignored + machine-local only, and a `git clean -fdx` destroyed it; it is committed now,
do not un-track it. The script runs `Bun.build` with:

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
# → dist/opencode-windows-x86/bin/opencode.exe  (coff-i386, ~165 MB with the
#   embedded Web UI; pass --skip-embed-web-ui to leave it out)
```

> The `Bun.build` compile step prints nothing until it finishes; a full run on
> this machine takes tens of minutes. Redirect output to a file rather than
> piping it (a piping consumer that exits early kills the build mid-compile).

> **Version string:** `Script.version` (`packages/script`) prefers the shell's
> `OPENCODE_VERSION` env var over everything else — a stale value gets baked into the
> binary via the `OPENCODE_VERSION` define and shows up in `--version`. Unset it before
> building (without it, the script fetches the latest published version from npm —
> or yields a `0.0.0-dev-<timestamp>` string when npm's version isn't usable).

### Known upstream gap: FFF native library

`@ff-labs/fff-bin-win32-x86` does not exist (FFF ships only x64/arm64). The win9x binary
runs without it (graceful fallback in `@ff-labs/fff-bun`); FFF-backed features will be
unavailable until FFF publishes 32-bit Windows binaries.

---

## 4. Verifying

```sh
dist/opencode-windows-x86/bin/opencode.exe --version   # 0.0.0-dev-<timestamp> (no OPENCODE_VERSION)
dist/opencode-windows-x86/bin/opencode.exe --help      # renders the OpenTUI banner
```

If the OpenTUI render library fails to load you'll see
`Failed to initialize OpenTUI render library: Unsupported OpenTUI Node asset target: win32-x86`
— that means the fork tarballs / win32-x86 native package aren't wired up (see §2–§3).

**models.dev fetch on XP** (exercises the libuv slow-select fix, §7):

```bat
del %USERPROFILE%\.cache\opencode\models.json
opencode.exe models        # lists models, exit 0, models.json re-created
```

---

## 5. XP / 9x compatibility of `opentui.dll`

The 32-bit `opentui.dll` is loaded by `opencode.exe` at runtime. To load on Windows XP
(and, in principle, 9x) it must not import Vista+/Win8+ APIs or the UCRT. Three layers
were handled (all in the `guilt/opentui` fork):

1. **Vista+ kernel32/ntdll entry points eliminated** — SRW locks, condition variables,
   Fls, `InitOnceExecuteOnce`, `GetSystemTimePreciseAsFileTime`, `GetThreadId`,
   `K32EnumProcessModules`, and the ntdll `Nt*` threading/notification functions are
   stubbed with XP-safe primitives. `src/win9x_compat.c` implements private
   `win9x_*` stubs; `src/win9x_imports.asm` (assembled with **NASM**, `-f win32`)
   defines `__imp__Foo@N` DATA symbols + `_Foo@N` code thunks that beat the import
   library, so no IAT entry is created.
2. **UCRT (api-ms-win-crt-*) remapped to msvcrt.dll** — the 45 CRT functions that exist
   in XP's `msvcrt.dll` are redirected there via a custom import library generated from
   `src/ucrt_msvcrt.def` (`lib.exe /def:… /machine:x86`). This removes the
   `api-ms-win-crt-heap/convert/filesystem/math/private/string/time/utility` imports.
3. **Remaining 10 UCRT-internal functions** (stdio routing `__acrt_iob_func` /
   `__stdio_common_*`, `_close`, and the onexit/init tables) are provided by two tiny
   shim DLLs shipped next to `opencode.exe`:
   `api-ms-win-crt-stdio-l1-1-0.dll` and `api-ms-win-crt-runtime-l1-1-0.dll`
   (`src/ucrt_shim.c`, built with clang-cl, `/NODEFAULTLIB`, kernel32-only). They
   resolve msvcrt functions at runtime via `GetProcAddress` so they load even where
   modern `msvcrt.dll` lacks the plain names.
4. **`wcsrtombs` (Vista+ CRT)** — `msvcrt.dll` on XP does not export it, so it stays
   on the UCRT (Zig binds it to `api-ms-win-crt-convert-l1-1-0.dll`). A third shim,
   `api-ms-win-crt-convert-l1-1-0.dll`, implements it on top of msvcrt's `wcstombs`.
   The msvcrt remap def must NOT list `wcsrtombs`; the import lib is generated with
   **GNU `dlltool`** (not `lib.exe /def:`, which emits empty import records here) and
   includes the data symbol `_iob` used by the stdio shims.
5. **`RtlExitUserProcess` / `RtlQueryPerformanceCounter` / `RtlQueryPerformanceFrequency`
   (Vista+ ntdll)** — absent from XP's ntdll; stubbed in `win9x_compat.c` on top of the
   kernel32 equivalents, with `__imp_` redirects in `win9x_imports.asm`.

Net: `opentui.dll` imports only `msvcrt.dll`, the three shims, and XP-safe
`KERNEL32`/`ntdll`/`USER32`. `opencode.exe` itself declares subsystem 5.01 (XP) and
its (embedded Bun) imports are XP-present DLLs; **Windows 9x is not feasible** because
the Bun runtime imports NT-only DLLs (`ntdll.dll`, `USERENV.dll`, `IPHLPAPI.dll`,
`WS2_32.dll`) that don't exist on 95/98/ME.

---

## 6. XP runtime: `fs.rm` recursive fails (EINVAL) and the models-dev lock stall

### Symptom

Every XP boot of `opencode.exe` stalled for ~5 minutes at `message=init` (one core pegged)
before rendering, with log errors:

- `Failed to fetch models.dev cause=... EINVAL: invalid argument, rm '...\locks\<hash>.lock'`
- `background dependency install failed ... Timed out waiting for lock: models-dev:...`

### Root cause

OpenCode's `Flock` (`packages/core/src/util/flock.ts`) deletes lock directories with
`fs.rm(path, { recursive: true, force: true })`. On the win9x Bun that call fails with
**EINVAL for any directory that has children**. Probe results on XP (bun 1.4.0):

| call | XP result |
| --- | --- |
| `rm(empty dir, { recursive: true })` | OK |
| `rm(dir with children, { recursive: true })` | **EINVAL** |
| `rmdir(dir)` / `unlink(file)` / `rm(file)` / `rm(nonexistent, force)` | OK |
| `readdir` / `opendir` (full iteration) | OK |

So `Flock.release()` threw and left `heartbeat` + `meta.json` behind, and every later
acquire found the stale lock plus a stale `.breaker` claim whose own cleanup also used
`rm(recursive)`. The breaker-removal error was swallowed, so the acquire loop spun
silently for the full 5-minute `timeoutMs` (the pegged CPU) and then threw
`Timed out waiting for lock`.

### Bun-side diagnosis (open, tracked in the Bun fork)

The failure is not in XP's NT layer. Native probes (`ntprobe.c`, `relprobe.c`, VS2005
on the XP box) show correct behavior for every primitive bun sits on:

- `NtCreateFile(dir, FILE_NON_DIRECTORY_FILE)` → `0xC00000BA`
  (`STATUS_FILE_IS_A_DIRECTORY`, the status bun maps to `EISDIR`),
- `NtCreateFile` with `RootDirectory` + relative names (file / subdir / missing) →
  `SUCCESS` / `FILE_IS_A_DIRECTORY` / `OBJECT_NAME_NOT_FOUND` as appropriate,
- `FileDispositionInformationEx` (class 64) → `STATUS_INVALID_INFO_CLASS` (Vista+;
  the legacy class-13 fallback engages, as designed).

Empty-dir `rm` succeeds on XP, so `zig_delete_tree`'s prologue (initial unlink probe →
EISDIR flip → dir open → iteration → final `rmdir`) works; only the **child walk**
fails (`src/runtime/node/node_fs.rs` → `dt_delete_file` / `dt_open_dir` with a
directory-fd). Suspects are bun's relative-path wrappers
(`openat_windows` / `normalize_path_windows`, `unlinkat` → `DeleteFileBun`).

### OpenCode-side fix (landed)

`Flock` now removes lock directories through `removeLockDir()`:

1. try `fs.rm(recursive)` (fast path, one syscall),
2. on failure fall back to a manual bottom-up delete using the primitives that work on
   XP (`readdir` + `unlink` + `rmdir`),
3. throw only when the directory survives both attempts — and stale `.breaker` eviction
   now throws instead of swallowing, so cleanup failures surface immediately instead of
   as a 5-minute timeout.

Verified on XP with the exact broken state seeded first (2-hour-stale `*.lock` with
children plus a stale `*.lock.breaker`): the new binary evicted the breaker, broke and
re-acquired the `models-dev` lock within seconds, reached `message=init` normally, and
the log contains no `Timed out waiting for lock` / `EINVAL` entries.

---

## 7. XP runtime: `Failed to fetch models.dev` (libuv slow-select race)

### Symptom

After the §6 lock fixes, models.dev and other HTTPS fetches on XP still failed
intermittently with `The socket connection was closed unexpectedly` surfacing as
`Failed to fetch models.dev` — disproportionately on larger transfers (a 2 MB
favicon took ~20 s or died; repro harnesses of 2–5 MB HTTP/HTTPS bodies failed
mid-stream).

### Root cause

XP always uses libuv's **slow select-thread poll path** for the win poller (the
fast AFD path needs `WSA_FLAG_NO_HANDLE_INHERIT`, a Vista+ socket flag). Upstream
`src/win/poll.c` could run **two select threads on the same socket concurrently**
(a disconnect-only req submitted right before a combined one), and XP's `select()`
then returns `WSAEINVAL (10022)` on a perfectly healthy socket. libuv maps that to
`UV_EINVAL (-4071)` and usockets error-closes the socket mid-transfer.

### Bun-side fix (landed)

`patches/libuv/win-poll-slow-select-xp.patch` in the Bun fork, declared in
`scripts/build/deps/libuv.ts` (applied after the rearm + abort patches): the slow
path only spawns select threads for readable/writable interest, empty interest
completes immediately, and a live-socket WSAEINVAL retries (bounded, with a
`SO_TYPE` liveness probe) instead of erroring the req. Full write-up and the
patch-regen recipe: `D:\WS\Bun\BUILD_WIN9X.md` → "libuv: XP slow-select poll fix".

### Verified on XP

- Both `fetch-repro` harnesses (favicon/models.dev/cachefly 2–5 MB, plain + TLS)
  run clean repeatedly: all `OK`, exit 0, no fatal poll callbacks; transfer times
  dropped to the normal range (favicon ~0.5 s vs ~20 s before).
- TUI boot renders immediately, and with `models.json` deleted,
  `opencode.exe models` re-fetches the catalog (5,264,597 bytes) and exits 0 —
  no `Failed to fetch models.dev`, no `toPublicInfo` TypeError in any log.

### Note: XP root certificates

HTTPS uses the system CA store (`--use-system-ca` in `execArgv`). XP's root store
is frozen/stale, so any certificate whose chain relies on roots rolled after XP's
era fails TLS regardless of this transport fix — models.dev and the shipped model
endpoints currently verify fine on the test box, but future root/leaf rollovers are
a separate, expected risk worth re-checking when a fetch suddenly starts failing
at the TLS layer instead of mid-transfer.