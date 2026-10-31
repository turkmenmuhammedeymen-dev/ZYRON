# ZYRON Web Client

Responsive, installable-ready web client shared with the Android WebView shell. Uses browser localStorage and the File API. No remote account access. `memlab.js` (Memory Lab) is inert unless the page runs inside the ZYRON Android app, where a root-gated native bridge (`window.ZyronMem`) exists; in a normal browser it is disabled.

Run locally with any static HTTP server from this directory (for example: `python -m http.server 8080`).