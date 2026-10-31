package com.zyron.lab

import android.content.Context
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.Executors

/**
 * Memory Lab köprüsü: web arayüzü <-> root yetkisiyle çalışan yerel çekirdek (libmemcore.so).
 *
 * Güvenlik:
 *  - Yalnızca bu uygulamanın kendi yerel sayfası (file:///android_asset) JS arayüzünü kullanabilir
 *    (MainActivity dış sitelere gitmeyi engeller).
 *  - Çekirdeğe sadece izin verilen komut kelimeleri ve katı bir karakter kalıbına uyan satırlar gider;
 *    kabuk (shell) komutu hiçbir zaman birleştirilmez.
 *  - Root izni, ancak kullanıcı Memory Lab'de "Root'u kontrol et" dediğinde istenir.
 *  - Sistem süreçlerine ve korumalı uygulamalara bağlanmayı çekirdek reddeder.
 */
class MemoryBridge(private val context: Context, private val webView: WebView) {
    private val executor = Executors.newSingleThreadExecutor()
    private var proc: Process? = null
    private var writer: BufferedWriter? = null
    private var reader: BufferedReader? = null

    private val allowedVerbs = setOf(
        "status", "ps", "attach", "detach", "reset", "region", "scan", "next",
        "list", "get", "set", "setall", "freeze", "unfreeze", "frozen"
    )
    // ör: "scan i32 1000", "set 0x7ffd1234 f32 -12.5", "next eq 5 10"
    private val linePattern = Regex("^[a-z]{2,10}( [A-Za-z0-9_.+\\-]{1,40}){0,4}$")

    private fun corePath() = File(context.applicationInfo.nativeLibraryDir, "libmemcore.so")

    /** {"abi":"arm64-v8a","binary":true} */
    @JavascriptInterface
    fun info(): String {
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "?"
        val f = corePath()
        return JSONObject().put("abi", abi).put("binary", f.exists()).put("sdk", Build.VERSION.SDK_INT).toString()
    }

    /** Root izni ister ve çekirdeği başlatır; sonucu id ile JS'e döner. */
    @JavascriptInterface
    fun checkRoot(id: Int) {
        executor.execute {
            val result = try {
                if (!corePath().exists()) {
                    err("no_binary", "Yerel çekirdek bu cihaz mimarisi için pakette yok.")
                } else {
                    ensureStarted()
                    sendLine("status")
                }
            } catch (e: Exception) {
                stop()
                err("no_root", "Root izni alınamadı veya su bulunamadı.")
            }
            deliver(id, result)
        }
    }

    @JavascriptInterface
    fun send(id: Int, command: String) {
        val verb = command.substringBefore(' ')
        if (command.length > 200 || verb !in allowedVerbs || !linePattern.matches(command)) {
            deliver(id, err("bad_command", "Geçersiz komut."))
            return
        }
        executor.execute {
            val result = try {
                ensureStarted()
                sendLine(command)
            } catch (e: Exception) {
                stop()
                err("core_exited", "Çekirdek kapandı. Root iznini yeniden kontrol et.")
            }
            deliver(id, result)
        }
    }

    private fun ensureStarted() {
        val p = proc
        if (p != null && p.isAlive) return
        stop()
        val started = ProcessBuilder("su", "-c", corePath().absolutePath).start()
        // stderr'i boşalt ki çekirdek bloke olmasın
        Thread {
            try {
                val buf = ByteArray(1024)
                val s = started.errorStream
                while (s.read(buf) >= 0) { /* at */ }
            } catch (_: Exception) {}
        }.apply { isDaemon = true }.start()
        proc = started
        writer = BufferedWriter(OutputStreamWriter(started.outputStream))
        reader = BufferedReader(InputStreamReader(started.inputStream))
    }

    private fun sendLine(command: String): String {
        val w = writer ?: throw IllegalStateException("not started")
        val r = reader ?: throw IllegalStateException("not started")
        w.write(command); w.write("\n"); w.flush()
        return r.readLine() ?: throw IllegalStateException("eof")
    }

    private fun err(code: String, msg: String) =
        JSONObject().put("ok", false).put("err", code).put("msg", msg).toString()

    private fun deliver(id: Int, json: String) {
        webView.post {
            webView.evaluateJavascript("window.zyronMemResult && window.zyronMemResult($id, ${JSONObject.quote(json)})", null)
        }
    }

    private fun stop() {
        try { writer?.write("quit\n"); writer?.flush() } catch (_: Exception) {}
        try { proc?.destroy() } catch (_: Exception) {}
        proc = null; writer = null; reader = null
    }

    fun shutdown() {
        executor.execute { stop() }
        executor.shutdown()
    }
}
