package dev.communal.spike

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import org.json.JSONObject

/**
 * EXPERIMENTAL (Android spike). Runs the TypeScript core as a child process, the way Electron runs
 * it in a utilityProcess: `libnode.so main.mjs` from the APK's native lib dir, with the local API on
 * 127.0.0.1 behind a bearer token only this process knows. The real app would start this from a
 * foreground service so Android doesn't kill transfers in the background.
 */
class CoreProcess(private val context: Context) {
    private var process: Process? = null
    private val token = ByteArray(24).also { SecureRandom().nextBytes(it) }
        .joinToString("") { "%02x".format(it) }
    @Volatile var apiUrl: String? = null
        private set
    @Volatile var startedAtMs = 0L
    @Volatile var readyAfterMs = 0L

    /** Copies the core bundle out of the APK (assets can't be loaded by Node directly). */
    private fun unpack(): File {
        val dir = File(context.filesDir, "core")
        val stamp = File(dir, ".version")
        val version = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
        if (stamp.exists() && stamp.readText() == version) return dir
        dir.deleteRecursively()
        val files = context.assets.open("core-files.txt").bufferedReader().readLines()
        for (rel in files) {
            val out = File(dir, rel)
            out.parentFile!!.mkdirs()
            context.assets.open("core/$rel").use { i -> out.outputStream().use { i.copyTo(it) } }
        }
        stamp.writeText(version)
        return dir
    }

    fun start(onLine: (String) -> Unit) {
        startedAtMs = System.currentTimeMillis()
        val core = unpack()
        val libDir = context.applicationInfo.nativeLibraryDir
        val data = File(context.filesDir, "communal").apply { mkdirs() }
        val downloads = File(context.getExternalFilesDir(null), "Downloads").apply { mkdirs() }
        val pb = ProcessBuilder("$libDir/libnode.so", File(core, "main.mjs").path)
            .directory(core)
            .redirectErrorStream(true)
        pb.environment().apply {
            put("LD_LIBRARY_PATH", libDir)
            put("HOME", context.filesDir.path)
            put("TMPDIR", context.cacheDir.path)
            put("COMMUNAL_DATA", data.path)
            put("COMMUNAL_DOWNLOADS", downloads.path)
            put("COMMUNAL_API_TOKEN", token)
            put("COMMUNAL_API_PORT", "0")
            // Spike only: the dev hub on the host uses a self-signed certificate.
            put("COMMUNAL_INSECURE_TLS", "true")
        }
        val p = pb.start()
        process = p
        Thread {
            p.inputStream.bufferedReader().forEachLine { line ->
                Log.i("communal-core", line)
                if (line.startsWith("API ")) {
                    apiUrl = line.removePrefix("API ").trim()
                    readyAfterMs = System.currentTimeMillis() - startedAtMs
                }
                onLine(line)
            }
            onLine("core exited with ${p.waitFor()}")
        }.apply { isDaemon = true }.start()
    }

    fun stop() {
        process?.destroy()
    }

    /** One local API call. Returns the parsed JSON body (errors included). */
    fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        val base = apiUrl ?: return JSONObject().put("error", "core not ready")
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 5_000
        c.readTimeout = 60_000
        c.setRequestProperty("Authorization", "Bearer $token")
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val stream = if (c.responseCode < 400) c.inputStream else c.errorStream
        val text = stream?.bufferedReader()?.readText().orEmpty()
        return runCatching { JSONObject(text) }.getOrElse { JSONObject().put("raw", text) }
    }
}
