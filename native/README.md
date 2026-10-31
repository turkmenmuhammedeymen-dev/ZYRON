# Memory Lab - native core

`memcore.c` is a single-file C program that scans, narrows, edits and freezes values in another
process's memory through `/proc/<pid>/maps` and `/proc/<pid>/mem`. It needs root.

```
ZYRON web UI (memlab.js) --window.ZyronMem--> MemoryBridge.kt --su -c libmemcore.so--> memcore
```

Protocol: one text command per line on stdin, exactly one JSON line back on stdout
(`ps`, `attach <pid>`, `region <all|anon|java|file|stack>`, `scan <type> <v> [v2]`,
`next <eq|changed|unchanged|inc|dec|incby|decby> [v] [v2]`, `list <offset> <count>`,
`get|set|freeze <0xaddr> <type> [value]`, `setall <v>`, `unfreeze <0xaddr>`, `frozen`, `detach`, `status`).
Types: `i8 i16 i32 i64 f32 f64`.

## Safety limits (enforced in code)
- Refuses pid 1, itself, system uids (`< 10000`, override only via `--min-uid` for tests),
  `com.android.*`, Google Play services, `zygote*`, `system_server` and ZYRON itself.
- Writes only into addresses inside currently mapped read-write regions of the attached process.
- `setall` writes at most 50 addresses, at most 64 frozen addresses, at most 3,000,000 scan hits.
- No shell, no file creation or deletion; the Kotlin bridge only forwards an allow-list of verbs with a strict
  character pattern, and the WebView refuses to navigate away from the bundled local pages.
- Frozen values are released automatically when the target process exits.
- Not included on purpose: anti-cheat evasion, hiding, speed hacks.

## Build and test
```
bash native/build-android.sh          # needs ANDROID_NDK_HOME; outputs app/src/main/jniLibs/<abi>/libmemcore.so
sudo python3 native/test_memcore.py   # core: scan/narrow/write/freeze + safety limits (33 checks)
sudo python3 native/test_ui.py        # real headless Chrome + real core drives the Memory Lab UI
```
Sanitizer run: `CORE_CC="cc -fsanitize=address,undefined -g" sudo -E python3 native/test_memcore.py`.

## Not verified here
The Linux tests above pass. The Android-specific parts (NDK build, `su` launch from the app's native lib dir,
Magisk/SELinux behaviour, WebView bridge) have not been run on a device yet.
