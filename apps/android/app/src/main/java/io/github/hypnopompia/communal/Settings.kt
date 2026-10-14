package io.github.hypnopompia.communal

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** The phone's own settings (the core keeps everything else). */
data class Settings(
    /** How often to catch up in the background: 0 (never), 1, 6 or 24 hours. */
    val syncHours: Int = 6,
    /** Only catch up in the background on Wi-Fi (or another unmetered network). */
    val wifiOnly: Boolean = true,
)

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val _value = MutableStateFlow(load())
    val value: StateFlow<Settings> = _value

    private fun load() = Settings(
        syncHours = prefs.getInt("sync_hours", 6),
        wifiOnly = prefs.getBoolean("wifi_only", true),
    )

    fun update(change: (Settings) -> Settings): Settings {
        val s = change(_value.value)
        prefs.edit()
            .putInt("sync_hours", s.syncHours)
            .putBoolean("wifi_only", s.wifiOnly)
            .apply()
        _value.value = s
        return s
    }
}
