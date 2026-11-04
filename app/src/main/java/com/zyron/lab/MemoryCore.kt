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
    private var practice: Process? = null
    /** "root" (su ile) veya "user" (rootsuz: yalnızca bu uygulamanın kendi kullanıcı alanı). */
    @Volatile private var mode = "root"

    private fun practicePath() = File(appContext.applicationInfo.nativeLibraryDir, "libpractice.so")

    /** Rootsuz mod için pratik oyununu başlatır; {"ok":true,"pid":N} döner. */
    fun startPractice(callback: (String) -> Unit) {
        executor.execute {
            val result = try {
                if (!practicePath().exists()) {
                    err("no_binary", "Pratik oyunu bu cihaz mimarisi için pakette yok.")
                } else {
                    if (!alive(practice)) {
                        practice = ProcessBuilder(practicePath().absolutePath).redirectErrorStream(true).start()
                    }
                    val p = practice!!
                    val line = BufferedReader(InputStreamReader(p.inputStream)).readLine() ?: ""
                    val pid = line.removePrefix("pid=").trim().toIntOrNull()
                    if (pid == null) err("start_failed", "Pratik oyunu başlatılamadı.")
                    else {
                        Thread { try { val b = ByteArray(256); while (p.inputStream.read(b) >= 0) { } } catch (e: Exception) { } }
                            .apply { isDaemon = true }.start()
                        JSONObject().put("ok", true).put("pid", pid).toString()
                    }
                }
            } catch (e: Exception) {
                err("start_failed", "Pratik oyunu başlatılamadı.")
            }
            callback(result)
        }
    }

    fun stopPractice() {
        try { practice?.destroy() } catch (e: Exception) { }
        practice = null
    }

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
    fun checkRoot(callback: (String) -> Unit) = checkMode("root", callback)

    /** Kipi seçer ("root" veya "user") ve çekirdeği o kipte (yeniden) başlatır. */
    fun checkMode(newMode: String, callback: (String) -> Unit) {
        executor.execute {
            if (newMode != mode) { stop(); mode = newMode }
            val result = try {
                if (!corePath().exists()) {
                    err("no_binary", "Yerel çekirdek bu cihaz mimarisi için pakette yok.")
                } else {
                    ensureStarted()
                    sendLine("status")
                }
            } catch (e: Exception) {
                stop()
                if (mode == "user") err("core_exited", "Çekirdek başlatılamadı.")
                else err("no_root", "Root izni alınamadı veya su bulunamadı.")
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
        val started = if (mode == "user") {
            val cmd = mutableListOf(corePath().absolutePath)
            if (SAFE_PATH.matches(data)) { cmd.add("--data-dir"); cmd.add(data) }
            if (SAFE_PATH.matches(tmp)) { cmd.add("--tmp-dir"); cmd.add(tmp) }
            ProcessBuilder(cmd).start()
        } else {
            ProcessBuilder("su", "-c", parts.toString()).start()
        }
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
