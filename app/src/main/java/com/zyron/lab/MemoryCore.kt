package com.zyron.lab

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.Executors

/**
 * Root yetkisiyle çalışan yerel çekirdeğin (libmemcore.so) tek örneği.
 * Ana pencere ve yüzen pencere aynı çekirdeği paylaşır. Uygulama süreci ölürse çekirdeğin stdin'i
 * kapanır ve çekirdek kendiliğinden çıkar (duraklatılmış oyunu da sürdürür).
 */
class MemoryCore private constructor(private val appContext: Context) {
    companion object {
        @Volatile private var instance: MemoryCore? = null
        private val SAFE_PATH = Regex("^[A-Za-z0-9_./-]+$")

        fun get(context: Context): MemoryCore {
            val existing = instance
            if (existing != null) return existing
            synchronized(MemoryCore::class.java) {
                val again = instance
                if (again != null) return again
                val created = MemoryCore(context.applicationContext)
                instance = created
                return created
            }
        }
    }

    private val executor = Executors.newSingleThreadExecutor()
    private var proc: Process? = null
    private var writer: BufferedWriter? = null
    private var reader: BufferedReader? = null

    private fun corePath() = File(appContext.applicationInfo.nativeLibraryDir, "libmemcore.so")

    private fun dataDir(): String {
        val ext = appContext.getExternalFilesDir(null)
        val dir = ext ?: appContext.filesDir
        dir.mkdirs()
        return dir.absolutePath
    }

    private fun alive(p: Process?): Boolean {
        if (p == null) return false
        return try {
            p.exitValue()
            false
        } catch (e: IllegalThreadStateException) {
            true
        }
    }

    fun isRunning(): Boolean = alive(proc)

    /** {"abi":"arm64-v8a","binary":true,"sdk":34,"dataDir":"..."} */
    fun info(): String {
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "?"
        return JSONObject()
            .put("abi", abi)
            .put("binary", corePath().exists())
            .put("sdk", Build.VERSION.SDK_INT)
            .put("dataDir", dataDir())
            .toString()
    }

    private fun err(code: String, msg: String): String =
        JSONObject().put("ok", false).put("err", code).put("msg", msg).toString()

    /** Root iznini ister ve çekirdeği başlatır. */
    fun checkRoot(callback: (String) -> Unit) {
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
            callback(result)
        }
    }

    fun request(command: String, callback: (String) -> Unit) {
        executor.execute {
            val result = try {
                ensureStarted()
                sendLine(command)
            } catch (e: Exception) {
                stop()
                err("core_exited", "Çekirdek kapandı. Root iznini yeniden kontrol et.")
            }
            callback(result)
        }
    }

    private fun ensureStarted() {
        if (alive(proc)) return
        stop()
        val data = dataDir()
        val tmp = appContext.cacheDir.absolutePath
        val parts = StringBuilder(corePath().absolutePath)
        if (SAFE_PATH.matches(data)) parts.append(" --data-dir ").append(data)
        if (SAFE_PATH.matches(tmp)) parts.append(" --tmp-dir ").append(tmp)
        val started = ProcessBuilder("su", "-c", parts.toString()).start()
        // stderr'i boşalt ki çekirdek bloke olmasın
        Thread {
            try {
                val buf = ByteArray(1024)
                val s = started.errorStream
                while (s.read(buf) >= 0) { /* at */ }
            } catch (e: Exception) {
                // yoksay
            }
        }.apply { isDaemon = true }.start()
        proc = started
        writer = BufferedWriter(OutputStreamWriter(started.outputStream))
        reader = BufferedReader(InputStreamReader(started.inputStream))
    }

    private fun sendLine(command: String): String {
        val w = writer ?: throw IllegalStateException("not started")
        val r = reader ?: throw IllegalStateException("not started")
        w.write(command)
        w.write("\n")
        w.flush()
        return r.readLine() ?: throw IllegalStateException("eof")
    }

    private fun stop() {
        try {
            writer?.write("quit\n")
            writer?.flush()
        } catch (e: Exception) {
            // yoksay
        }
        try {
            proc?.destroy()
        } catch (e: Exception) {
            // yoksay
        }
        proc = null
        writer = null
        reader = null
    }
}
