package io.github.hypnopompia.communal

import android.content.Context
import android.media.MediaScannerConnection

/**
 * Tells Android's media library about finished downloads, so music players and the gallery see
 * them right away (files in Download/ are indexed by MediaStore, but only when scanned). It
 * remembers the newest transfer it has scanned, so each file is scanned once even across
 * restarts.
 */
class MediaIndex(private val context: Context) {
    private val prefs = context.getSharedPreferences("media", Context.MODE_PRIVATE)

    @Synchronized
    fun scanFinished(transfers: List<Transfer>) {
        val since = prefs.getLong(KEY, 0L)
        val fresh = transfers.filter { it.state == "done" && it.final_path != null && it.updated_at >= since }
        if (fresh.isEmpty()) return
        MediaScannerConnection.scanFile(context, fresh.map { it.final_path!! }.toTypedArray(), null, null)
        prefs.edit().putLong(KEY, fresh.maxOf { it.updated_at }).apply()
    }

    /** A file that left (a mirrored deletion): scanning its old path drops it from the library. */
    fun forget(path: String) {
        MediaScannerConnection.scanFile(context, arrayOf(path), null, null)
    }

    private companion object {
        const val KEY = "scanned_through"
    }
}
