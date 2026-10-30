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

## Technology
- HTML, CSS and JavaScript for the shared client
- Android WebView + Kotlin for the Android shell
- Android Gradle Plugin / Gradle 8.9
- PWA manifest and service worker for supported browsers

## Local development
Serve the `web/` folder using a local static server, e.g. `python -m http.server 8080` from that folder.

## Deployment
The repository includes `vercel.json` to route the site root to `web/index.html`. Connect this repository to Vercel with the repository root as the project root and deploy.

## Android build
Run `gradle assembleDebug`. The Gradle pre-build task bundles `web/` into the APK. GitHub Actions validates the web client and builds the debug APK.

## Scope and privacy
ZYRON is designed for local sample data, files the user explicitly selects, and software/data the user owns or is authorized to test. It does not inspect other apps' private storage, modify third-party games or online currencies, or bypass anti-cheat/security controls. Workspace data is stored locally in the browser/WebView.
