# ZYRON

**Beyond the Game.**

ZYRON is a responsive, local-first workspace available on the web and Android. The same web client powers the browser experience and is bundled into the Android APK.

## Platforms
- **Web:** Open the deployed Vercel site in a desktop or mobile browser. The web client is a Progressive Web App with an offline shell cache.
- **Android:** The Android app hosts the exact same `web/` client in a secure WebView. Gradle copies web assets into the APK during `preBuild`.

## Memory Lab (the whole app)
ZYRON is now a single Game Guardian-style screen: a process bar on top and a bottom menu with Process, Search, Saved list, Memory (hex), Map, Script and Settings. The old Test Lab, File Lab, Diagnostics, Profiles and CPM Lab demo screens were removed.
- Memory Lab — optional, rooted Android only: Game Guardian-style search (exact/range/fuzzy/group/text/bytes/XOR/auto), refine, edit, directional freeze, saved list, pointer search, hex viewer, memory map, dump, pause, JS scripts and a floating window over the app you select (see *Scope and privacy*).

## Technology
- HTML, CSS and JavaScript for the shared client
- Android WebView + Kotlin for the Android shell
- C core for Memory Lab (`native/memcore.c`), built with the Android NDK and started through `su`
- Android Gradle Plugin / Gradle 8.9
- PWA manifest and service worker for supported browsers

## Local development
Serve the `web/` folder using a local static server, e.g. `python -m http.server 8080` from that folder.

## Deployment
The repository includes `vercel.json` to route the site root to `web/index.html`. Connect this repository to Vercel with the repository root as the project root and deploy.

## Android build
Run `bash native/build-android.sh` (needs `ANDROID_NDK_HOME`) to build the Memory Lab core into `app/src/main/jniLibs/`, then `gradle assembleDebug`. The Gradle pre-build task bundles `web/` into the APK. GitHub Actions tests the core and the Memory Lab UI, validates the web client and builds the debug APK.

See `native/README.md` for the Memory Lab architecture, safety limits and tests.

## Scope and privacy
The saved list and scripts are stored locally in the browser/WebView; nothing is uploaded.

**Memory Lab is different and is opt-in.** On a rooted Android device, after the user grants root and picks an app, it can read and write that app's memory. Use it only on offline or single-player software you own or are authorized to test, never on online games or other people's accounts. It does not bypass anti-cheat or security controls, does not hide itself, has no speed hack or disassembler, and refuses system processes and protected apps (`com.android.*`, Google Play services, ZYRON itself). It is unavailable in the web client and on non-rooted devices.
