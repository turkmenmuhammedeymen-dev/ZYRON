# ZYRON

**Beyond the Game.**

ZYRON is a responsive, local-first workspace available on the web and Android. The same web client powers the browser experience and is bundled into the Android APK.

## Platforms
- **Web:** Open the deployed Vercel site in a desktop or mobile browser. The web client is a Progressive Web App with an offline shell cache.
- **Android:** The Android app hosts the exact same `web/` client in a secure WebView. Gradle copies web assets into the APK during `preBuild`.

## Workspace
- Test Lab — add, search, filter, edit, adjust and delete ZYRON-owned sample values.
- File Lab — preview explicitly selected text/JSON/XML files and import validated JSON arrays.
- Profiles — save, load and delete local workspace profiles.
- Diagnostics — inspect browser/device environment and local activity history.
- JSON export — export local test values.
- Memory Lab — optional, rooted Android only: scan, narrow, edit and freeze values in the memory of an app you select (see *Scope and privacy*).

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
ZYRON's labs (Test Lab, File Lab, Profiles, Diagnostics, CPM Lab demo) work only on local sample data and files the user explicitly selects. Workspace data is stored locally in the browser/WebView.

**Memory Lab is different and is opt-in.** On a rooted Android device, after the user grants root and picks an app, it can read and write that app's memory. Use it only on offline or single-player software you own or are authorized to test, never on online games or other people's accounts. It does not bypass anti-cheat or security controls, does not hide itself, and refuses system processes and protected apps (`com.android.*`, Google Play services, ZYRON itself). It is unavailable in the web client and on non-rooted devices.
