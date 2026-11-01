# Memory Lab - native core (v2)

`memcore.c` is a single-file C program that scans, narrows, edits, freezes and inspects values in another
process's memory through `/proc/<pid>/maps` and `/proc/<pid>/mem`. It needs root.

```
ZYRON web UI (memlab.js) --window.ZyronMem--> MemoryBridge.kt --su -c libmemcore.so--> memcore
                                  \-- OverlayService.kt (floating window, same UI with ?overlay=1)
```

Protocol: one text command per line on stdin, exactly one JSON line back on stdout.

| Area | Commands |
|---|---|
| Session | `status`, `ps`, `attach <pid>`, `detach`, `reset`, `pause`, `resume` |
| Regions | `region <list\|all\|A,Ja,Jh,Ch,Ca,Cd,Cb,S,As,V,Xa,Xs,O,...>` (GG-style classes) |
| Search | `scan <type\|auto\|bytes> <v> [v2]` (exact, range, XOR, text/hex), `fuzzy <type>`, `gscan <type> <window> <v[:type]\|lo..hi[:type]>...` (group) |
| Refine | `next <eq\|ne\|gt\|lt\|changed\|unchanged\|inc\|dec\|incby\|decby> [v] [v2]` |
| Results | `list <off> <count>`, `get`, `getm`, `drop`, `shift <delta> [type]`, `ptrscan`, `jump` |
| Write | `set`, `setall`, `setbytes`, `freeze <addr> <type> <v> [n\|inc\|dec]`, `unfreeze`, `frozen` |
| Inspect | `hex <addr> <len<=512>`, `maps <off> <count<=200>`, `dump <start> <end> <name>` |

Types: `i8 i16 i32 i64 f32 f64 xor bytes auto`.

## Safety limits (enforced in code)
- Refuses pid 1, itself, system uids (`< 10000`, override only via `--min-uid` for tests),
  `com.android.*`, Google Play services, `zygote*`, `system_server` and ZYRON itself.
- Writes only into addresses inside currently mapped read-write regions of the attached process.
- `setall` ≤ 2000 addresses, ≤ 256 frozen addresses, ≤ 3,000,000 scan hits.
- `pause` (SIGSTOP) is protected by a watchdog (`--max-pause`, default 300 s, min 5 s); the target is also resumed
  on detach, exit and on SIGTERM/SIGINT of the core.
- Files: only `dump` writes a file, only inside `--data-dir`, with a safe file name, at most 256 MB. Fuzzy search uses an
  unlinked temporary snapshot in `--tmp-dir`.
- No shell; the Kotlin bridge forwards only an allow-list of verbs with a strict character pattern, and the WebView
  refuses to navigate away from the bundled local pages.
- Frozen values are released automatically when the target process exits.
- Not included on purpose: anti-cheat evasion, self-hiding, speed hack, ASM patching/disassembly. Lua scripts are
  replaced by a JavaScript `gg`-like API in the UI (not Lua-compatible).

## Build and test
```
bash native/build-android.sh          # needs ANDROID_NDK_HOME; outputs app/src/main/jniLibs/<abi>/libmemcore.so
sudo python3 native/test_memcore.py   # core: 117 checks (search kinds, refine, freeze modes, pointers, pause, limits)
sudo python3 native/test_ui.py        # real headless Chrome + real core drives the Memory Lab UI (normal + overlay)
```
Sanitizer run: `CORE_CC="cc -fsanitize=address,undefined -g -O1" sudo -E python3 native/test_memcore.py`.

## Not verified here
The Linux tests above pass. The Android-specific parts (NDK build, Kotlin compile, `su` launch from the app's native
lib dir, Magisk/SELinux behaviour, WebView bridge, floating window) have not been run on a device; the first Kotlin
compile happens in CI.
