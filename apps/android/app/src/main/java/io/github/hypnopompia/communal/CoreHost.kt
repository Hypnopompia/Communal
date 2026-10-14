package io.github.hypnopompia.communal

import android.content.Context
import android.os.Build
import android.os.Environment
import android.util.Log
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Runs the TypeScript core as a child process (ADR 0023), the way the desktop runs it in a
 * utilityProcess: `libnode.so main.mjs` from the APK's native lib dir, with the local API on
 * 127.0.0.1 behind a bearer token only this process knows. The device key and the token go to
 * the core on stdin. If the core dies, it's started again with a growing delay.
 */
class CoreHost(
    private val context: Context,
    private val keys: DeviceKeys,
    /** A file the core moved to its trash (a mirrored deletion): no longer in the media library. */
    private val onTrashed: (String) -> Unit = {},
) {
    sealed interface State {
        data object Stopped : State
        data object Starting : State
        data class Ready(val url: String) : State
        data class Failed(val message: String) : State
    }

    val token: String = ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val _state = MutableStateFlow<State>(State.Stopped)
    val state: StateFlow<State> = _state
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var process: Process? = null
    private var wanted = false
    /** Bumped on every start and stop, so an old run loop knows to quit. */
    private var generation = 0
    private var failures = 0
    private val recentLines = ArrayDeque<String>()

    /** Where downloads land: Download/Communal on shared storage, so other apps can open them. */
    val downloadsDir: File =
        File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Communal")

    @Synchronized
    fun start() {
        if (wanted) return
        wanted = true
        failures = 0
        val gen = ++generation
        // A core that is still stopping must be gone first: two would share one database.
        val previous = process
        scope.launch {
            previous?.let { p ->
                if (!p.waitFor(6, TimeUnit.SECONDS)) p.destroyForcibly().waitFor()
            }
            run(gen)
        }
    }

    @Synchronized
    fun stop() {
        wanted = false
        generation++
        process?.let { p ->
            // Closing stdin asks the core to stop cleanly; destroy() is the backstop.
            runCatching { p.outputStream.close() }
            scope.launch {
                delay(5_000)
                if (p.isAlive) p.destroy()
            }
        }
        _state.value = State.Stopped
    }

    private fun current(gen: Int) = synchronized(this) { wanted && generation == gen }

    private suspend fun run(gen: Int) {
        while (current(gen)) {
            _state.value = State.Starting
            val code = runCatching { runOnce(gen) }.getOrElse {
                Log.e(TAG, "core failed to start", it)
                -1
            }
            if (!current(gen)) break
            failures++
            val tail = synchronized(recentLines) { recentLines.lastOrNull { it.contains("\"level\":60") || it.contains("Error") } }
            _state.value = State.Failed("The engine stopped (code $code)" + (tail?.let { ": ${errorText(it)}" } ?: ""))
            delay(minOf(60_000L, 1_000L shl minOf(failures, 6)))
        }
    }

    private fun runOnce(gen: Int): Int {
        val core = unpack()
        val libDir = context.applicationInfo.nativeLibraryDir
        val data = File(context.filesDir, "communal").apply { mkdirs() }
        downloadsDir.mkdirs()
        val pb = ProcessBuilder("$libDir/libnode.so", "--max-old-space-size=192", File(core, "main.mjs").path)
            .directory(core)
            .redirectErrorStream(true)
        pb.environment().apply {
            put("LD_LIBRARY_PATH", libDir)
            put("HOME", context.filesDir.path)
            put("TMPDIR", context.cacheDir.path)
            put("COMMUNAL_DATA", data.path)
            put("COMMUNAL_DOWNLOADS", downloadsDir.path)
            // On shared storage like the downloads, so a mirrored deletion is a rename; the app's
            // own folder there (Android/data/…) isn't indexed by the media library.
            put("COMMUNAL_TRASH", File(context.getExternalFilesDir(null), "trash").path)
            put("COMMUNAL_VERSION", BuildConfig.VERSION_NAME)
            put("COMMUNAL_BUILD", BuildConfig.COMMUNAL_BUILD)
            // Debug builds talk to a dev hub with a self-signed certificate (dev-only switch).
            if (BuildConfig.DEBUG) put("COMMUNAL_DEV_TLS", "self-signed")
        }
        val p = synchronized(this) {
            if (!current(gen)) return 0
            pb.start().also { process = it }
        }
        val secrets = JSONObject().put("device_key", keys.seed()).put("api_token", token)
        p.outputStream.write((secrets.toString() + "\n").toByteArray())
        p.outputStream.flush()
        p.inputStream.bufferedReader().forEachLine { line ->
            synchronized(recentLines) {
                recentLines.addLast(line)
                while (recentLines.size > 50) recentLines.removeFirst()
            }
            if (line.startsWith("API ") && current(gen)) {
                failures = 0
                _state.value = State.Ready(line.removePrefix("API ").trim())
            } else if (line.startsWith("TRASHED ")) {
                onTrashed(line.removePrefix("TRASHED "))
            } else {
                Log.i(TAG, line)
            }
        }
        return p.waitFor()
    }

    /**
     * Copies this ABI's core bundle out of the APK on the first start after an install or update
     * (Node can't load files from inside the APK).
     */
    private fun unpack(): File {
        val abi = Build.SUPPORTED_ABIS.firstOrNull { abi ->
            runCatching { context.assets.open("core/$abi/files.txt").close() }.isSuccess
        } ?: error("this app has no engine for ${Build.SUPPORTED_ABIS.joinToString()}")
        val dir = File(context.filesDir, "core")
        val stamp = File(dir, ".version")
        val version = "${BuildConfig.VERSION_CODE}:$abi:" +
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        if (stamp.exists() && stamp.readText() == version) return dir
        dir.deleteRecursively()
        val files = context.assets.open("core/$abi/files.txt").bufferedReader().readLines()
        for (rel in files) {
            if (rel.isBlank()) continue
            val out = File(dir, rel)
            out.parentFile!!.mkdirs()
            context.assets.open("core/$abi/$rel").use { i -> out.outputStream().use { i.copyTo(it) } }
        }
        stamp.writeText(version)
        return dir
    }

    private fun errorText(line: String): String =
        runCatching { JSONObject(line).optString("msg").ifBlank { line } }.getOrDefault(line).take(200)

    private companion object {
        const val TAG = "communal-core"
    }
}
