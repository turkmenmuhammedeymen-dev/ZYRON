package com.zyron.lab

import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * Web arayüzü (memlab.js) ile MemoryCore arasındaki köprü. Hem ana pencerede hem yüzen pencerede kullanılır.
 *
 * Güvenlik:
 *  - Yalnızca uygulamanın kendi yerel sayfaları (file:///android_asset/www/) bu arayüzü kullanabilir:
 *    WebView dış adreslere gitmeye izin vermez.
 *  - Çekirdeğe sadece izin verilen komut kelimeleri ve katı bir karakter kalıbına uyan satırlar gider;
 *    kabuk (shell) komutu hiçbir zaman birleştirilmez.
 *  - Root izni, ancak kullanıcı Memory Lab'de "Root'u kontrol et" dediğinde istenir.
 *  - Sistem süreçlerine ve korumalı uygulamalara bağlanmayı çekirdek reddeder.
 */
class MemoryBridge(
    @Suppress("unused") private val context: Context,
    private val core: MemoryCore,
    private val webView: WebView,
    private val onOpenOverlay: (() -> Unit)?
) {
    private val allowedVerbs = setOf(
        "status", "ps", "attach", "detach", "reset", "region", "scan", "fuzzy", "gscan", "next",
        "list", "get", "getm", "set", "setall", "setbytes", "freeze", "unfreeze", "frozen", "drop",
        "ptrscan", "jump", "shift", "hex", "maps", "dump", "pause", "resume"
    )
    // ör: "scan i32 1000", "set 0x7ffd1234 f32 -12.5", "gscan i32 512 100:i32 200:f32", "region cheap,anon"
    private val linePattern = Regex("^[a-z]{2,10}( [A-Za-z0-9_.+:,\\-]{1,130}){0,41}$")

    @JavascriptInterface
    fun info(): String = core.info()

    @JavascriptInterface
    fun isRunning(): Boolean = core.isRunning()

    @JavascriptInterface
    fun checkRoot(id: Int) {
        core.checkRoot { json -> deliver(id, json) }
    }

    @JavascriptInterface
    fun send(id: Int, command: String) {
        val verb = command.substringBefore(' ')
        if (command.length > 1800 || verb !in allowedVerbs || !linePattern.matches(command)) {
            deliver(id, err("bad_command", "Geçersiz komut."))
            return
        }
        core.request(command) { json -> deliver(id, json) }
    }

    @JavascriptInterface
    fun openOverlay() {
        onOpenOverlay?.invoke()
    }

    private fun err(code: String, msg: String): String =
        JSONObject().put("ok", false).put("err", code).put("msg", msg).toString()

    private fun deliver(id: Int, json: String) {
        webView.post {
            webView.evaluateJavascript(
                "window.zyronMemResult && window.zyronMemResult($id, ${JSONObject.quote(json)})", null
            )
        }
    }
}
