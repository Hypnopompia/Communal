package io.github.hypnopompia.communal.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.hypnopompia.communal.ApiError
import io.github.hypnopompia.communal.CommunalApp
import io.github.hypnopompia.communal.CoreHost
import io.github.hypnopompia.communal.LibraryDevice
import io.github.hypnopompia.communal.RemoteDevice
import io.github.hypnopompia.communal.Status
import io.github.hypnopompia.communal.Subscription
import io.github.hypnopompia.communal.Transfer
import io.github.hypnopompia.communal.Updates
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.launch

/** A computer this phone can send requests to, and whether it takes them (its setting). */
data class Remote(val device: RemoteDevice, val allowed: Boolean?, val destinations: List<String> = emptyList())

/**
 * The app's shared state, refreshed when the core says something changed (`/v1/events`) rather
 * than by polling, as the desktop does.
 */
class AppModel(application: Application) : AndroidViewModel(application) {
    private val app = application as CommunalApp
    val api = app.api
    val core: StateFlow<CoreHost.State> = app.core.state
    val settings = app.settings

    val status = MutableStateFlow<Status?>(null)
    val transfers = MutableStateFlow<List<Transfer>>(emptyList())
    val subscriptions = MutableStateFlow<List<Subscription>>(emptyList())
    val library = MutableStateFlow<List<LibraryDevice>>(emptyList())
    val remotes = MutableStateFlow<List<Remote>>(emptyList())
    /** Your connection state with each person, per ready hub (hub id → user id → state). */
    val connections = MutableStateFlow<Map<String, Map<String, String>>>(emptyMap())
    /** Phones of this account (this one included): they never share, so Library leaves them out. */
    val phones = MutableStateFlow<Set<String>>(emptySet())
    val update = MutableStateFlow<Updates.Available?>(null)
    /** One line for the snackbar: what just happened, or what went wrong. */
    val message = MutableStateFlow<String?>(null)
    /** Bumped on every change hint, for screens that load their own data (browse). */
    val tick = MutableStateFlow(0)

    init {
        viewModelScope.launch {
            core.collect { if (it is CoreHost.State.Ready) refresh(setOf("*")) }
        }
        viewModelScope.launch {
            api.events()
                .retryWhen { _, _ ->
                    delay(2_000)
                    true
                }
                .collect { refresh(it) }
        }
        // Progress isn't announced byte by byte: while something downloads, look every second.
        viewModelScope.launch {
            while (true) {
                delay(1_000)
                if (transfers.value.any { it.state == "active" }) refreshTransfers()
            }
        }
        viewModelScope.launch { update.value = app.updates.check() }
    }

    private fun refresh(topics: Set<String>) {
        val all = "*" in topics
        viewModelScope.launch {
            if (all || "hubs" in topics || "devices" in topics) runCatching { status.value = api.status() }
            if (all || "transfers" in topics) refreshTransfers()
            if (all || "subscriptions" in topics) runCatching { subscriptions.value = api.subscriptions().subscriptions }
            if (all || "library" in topics || "presence" in topics) runCatching { library.value = api.library().devices }
            if (all || "people" in topics || "hubs" in topics) refreshConnections()
            if (all || "devices" in topics || "presence" in topics) refreshRemotes()
            tick.value++
        }
    }

    fun reloadConnections() = viewModelScope.launch { refreshConnections() }

    private suspend fun refreshConnections() {
        val hubs = status.value?.hubs?.filter { it.ready } ?: return
        connections.value = hubs.mapNotNull { h ->
            runCatching { h.id to api.connections(h.id).connections.associate { it.user_id to it.state } }.getOrNull()
        }.toMap()
    }

    private suspend fun refreshTransfers() {
        runCatching { transfers.value = api.downloads().downloads }
    }

    fun refreshRemotes() = viewModelScope.launch {
        val devices = runCatching { api.remoteDevices().devices }.getOrNull() ?: return@launch
        // Other phones can't download for us: only computers.
        val computers = devices.filter { it.platform != "android" }
        phones.value = devices.filter { it.platform == "android" }.map { it.device_id }.toSet()
        val known = remotes.value.associateBy { it.device.device_id }
        remotes.value = computers.map { Remote(it, known[it.device_id]?.allowed, known[it.device_id]?.destinations.orEmpty()) }
        for (d in computers.filter { it.online }) {
            val hello = runCatching { api.remoteHello(d.device_id) }.getOrNull()
            remotes.value = remotes.value.map {
                if (it.device.device_id == d.device_id) it.copy(allowed = hello?.allowed, destinations = hello?.destinations.orEmpty()) else it
            }
        }
    }

    /** Runs an action, saying `done` when it worked and the core's message when it didn't. */
    fun act(done: String?, block: suspend () -> Unit) = viewModelScope.launch {
        try {
            block()
            if (done != null) message.value = done
        } catch (e: ApiError) {
            message.value = e.message
        } catch (e: Exception) {
            message.value = e.message ?: "Something went wrong"
        }
    }

    fun reloadStatus() = viewModelScope.launch { runCatching { status.value = api.status() } }

    fun checkForUpdate() = viewModelScope.launch {
        update.value = app.updates.check(force = true)
        if (update.value == null) message.value = "You have the latest version"
    }
}
