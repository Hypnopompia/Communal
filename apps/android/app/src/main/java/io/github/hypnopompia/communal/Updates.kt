package io.github.hypnopompia.communal

import android.content.Context
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * New versions come as an APK on the project's GitHub releases (ADR 0023). The app checks the
 * latest release at most once a day and offers it; installing is the person's choice, through
 * Android's own installer.
 */
class Updates(context: Context) {
    @Serializable data class Asset(val name: String, val browser_download_url: String)

    @Serializable data class Release(val tag_name: String, val html_url: String, val assets: List<Asset> = emptyList())

    data class Available(val version: String, val apk: String, val page: String)

    private val prefs = context.getSharedPreferences("updates", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()

    suspend fun check(force: Boolean = false): Available? = withContext(Dispatchers.IO) {
        val now = System.currentTimeMillis()
        val cached = prefs.getString("release", null)
        val body = if (!force && cached != null && now - prefs.getLong("checked_at", 0) < DAY_MS) {
            cached
        } else {
            val req = Request.Builder()
                .url("https://api.github.com/repos/Hypnopompia/Communal/releases/latest")
                .header("Accept", "application/vnd.github+json")
                .build()
            runCatching { http.newCall(req).execute().use { if (it.isSuccessful) it.body?.string() else null } }
                .getOrNull()
                ?.also { prefs.edit().putString("release", it).putLong("checked_at", now).apply() }
                ?: cached
        } ?: return@withContext null
        val r = runCatching { json.decodeFromString(Release.serializer(), body) }.getOrNull() ?: return@withContext null
        val version = r.tag_name.removePrefix("v")
        val apk = r.assets.firstOrNull { it.name.endsWith(".apk") && it.name.contains("arm64") }
            ?: r.assets.firstOrNull { it.name.endsWith(".apk") }
        if (apk == null || !newer(version, BuildConfig.VERSION_NAME)) return@withContext null
        Available(version, apk.browser_download_url, r.html_url)
    }

    private fun newer(a: String, b: String): Boolean {
        val pa = a.split("-")[0].split(".").map { it.toIntOrNull() ?: 0 }
        val pb = b.split("-")[0].split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { 0 }
            val y = pb.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    private companion object {
        const val DAY_MS = 24 * 60 * 60_000L
    }
}
