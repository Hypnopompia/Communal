package io.github.hypnopompia.communal

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

/**
 * Decides when the core runs (ADR 0023). Whoever needs it holds it: the foreground service
 * while the app is open or a download moves, and a background sync while its window is open.
 * When nobody holds it, it stops, so an idle phone doesn't keep a process and a socket going.
 */
class Keeper(private val app: CommunalApp) {
    private val holders = mutableSetOf<String>()

    @Synchronized
    fun hold(who: String) {
        holders += who
        app.core.start()
    }

    @Synchronized
    fun release(who: String) {
        holders -= who
        if (holders.isEmpty()) app.core.stop()
    }

    /**
     * Returns once there's nothing to do: no download moving for a while, and `until` passed.
     * `keep` can hold it longer (the app is open). Reports a status line for a notification.
     */
    suspend fun untilIdle(until: Long, keep: () -> Boolean, status: (String) -> Unit) {
        var lastBusy = System.currentTimeMillis()
        while (currentCoroutineContext().isActive) {
            delay(TICK_MS)
            val transfers = runCatching { withContext(Dispatchers.IO) { app.api.downloads().downloads } }
                .onFailure { Log.d("communal", "status check failed: ${it.message}") }
                .getOrNull() ?: continue
            app.media.scanFinished(transfers)
            val active = transfers.count { it.state == "active" }
            val waiting = transfers.count { it.state == "queued" || it.state == "waiting" }
            val now = System.currentTimeMillis()
            if (active > 0) lastBusy = now
            status(
                when {
                    active > 0 -> "Downloading ${plural(active, "file")}"
                    waiting > 0 -> "${plural(waiting, "download")} waiting for a source"
                    else -> "Connected"
                },
            )
            // Queued downloads whose sources are offline don't keep the phone awake: the next
            // sync window tries again.
            if (!keep() && active == 0 && now - lastBusy > GRACE_MS && now > until) return
        }
    }

    private companion object {
        const val TICK_MS = 5_000L
        const val GRACE_MS = 2 * 60_000L
    }
}

fun plural(n: Int, word: String) = "$n $word${if (n == 1) "" else "s"}"
