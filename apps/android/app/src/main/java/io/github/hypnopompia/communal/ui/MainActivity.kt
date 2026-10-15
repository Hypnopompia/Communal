package io.github.hypnopompia.communal.ui

import android.Manifest
import android.app.ActivityManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.CoreHost
import io.github.hypnopompia.communal.Hub

class MainActivity : ComponentActivity() {
    private val model: AppModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // The progress notification needs this on Android 13+; the app works without it.
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
            .launch(Manifest.permission.POST_NOTIFICATIONS)
        setContent { CommunalTheme { Root(model) } }
    }
}

/** The desktop's screens that make sense on a phone that only downloads (ADR 0023). */
private enum class Tab(val label: String, val icon: ImageVector) {
    Library("Library", Glyphs.Library),
    Search("Search", Glyphs.Search),
    People("People", Glyphs.People),
    Transfers("Transfers", Glyphs.Transfers),
    Settings("Settings", Glyphs.Settings),
}

@Composable
private fun Root(model: AppModel) {
    val core by model.core.collectAsStateWithLifecycle()
    val status by model.status.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val message by model.message.collectAsStateWithLifecycle()
    LaunchedEffect(message) {
        message?.let {
            snackbar.showSnackbar(it)
            model.message.value = null
        }
    }
    val ready = core as? CoreHost.State.Ready
    val s = status
    val stage = when {
        ready == null || s == null -> 0
        s.account.user_id == null || s.hubs.isEmpty() -> 1
        else -> 2
    }
    AnimatedContent(stage, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "stage") {
        when (it) {
            0 -> Starting(core)
            1 -> Setup(model, snackbar)
            else -> Main(model, snackbar)
        }
    }
}

@Composable
private fun Starting(core: CoreHost.State) {
    Box(
        Modifier.fillMaxSize().padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.widthIn(max = 320.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Mark(72.dp)
            if (core is CoreHost.State.Failed) {
                Text("Communal couldn’t start", style = MaterialTheme.typography.titleLarge)
                Text(core.message, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("Trying again…", color = Brand.tones.faint)
            } else {
                Text("Communal", style = MaterialTheme.typography.headlineSmall)
                LinearProgressIndicator(Modifier.size(width = 120.dp, height = 4.dp))
            }
        }
    }
}

/** A place in the Library: a device of someone's, and a folder on it ("" is the top). */
data class Place(val hub: String, val device: String, val name: String, val path: String = "")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Main(model: AppModel, snackbar: SnackbarHostState) {
    var tab by rememberSaveable { mutableStateOf(Tab.Library) }
    var place by remember { mutableStateOf<Place?>(null) }
    val transfers by model.transfers.collectAsStateWithLifecycle()
    val connections by model.connections.collectAsStateWithLifecycle()
    val update by model.update.collectAsStateWithLifecycle()
    val status by model.status.collectAsStateWithLifecycle()
    val hubs = status?.hubs.orEmpty()
    BackHandler(enabled = place != null || tab != Tab.Library) {
        val p = place
        when {
            tab == Tab.Library && p != null && p.path.isNotEmpty() -> place = p.copy(path = parentOf(p.path))
            tab == Tab.Library && p != null -> place = null
            else -> tab = Tab.Library
        }
    }
    // Counts that need the person, as the desktop's sidebar shows them.
    val badges = mapOf(
        Tab.People to connections.values.flatten().filter { it.state == "pending_in" }.map { it.user_id }.toSet().size,
        Tab.Transfers to transfers.count { it.state == "active" || it.state == "queued" },
        Tab.Settings to (if (update != null) 1 else 0) + hubs.count { it.problem != null },
    )
    val browsing = tab == Tab.Library && place != null
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            if (!browsing) {
                TopAppBar(
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Mark(28.dp)
                            Text(tab.label, style = MaterialTheme.typography.titleLarge)
                        }
                    },
                    actions = { HubState(hubs) { tab = Tab.Settings } },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                )
            }
        },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
                for (t in Tab.entries) {
                    NavigationBarItem(
                        selected = t == tab,
                        onClick = {
                            if (t == Tab.Library && tab == Tab.Library) place = null
                            tab = t
                        },
                        icon = {
                            val n = badges[t] ?: 0
                            BadgedBox(badge = { if (n > 0) Badge { Text("$n") } }) { Icon(t.icon, null) }
                        },
                        label = { Text(t.label, maxLines = 1) },
                        colors = NavigationBarItemDefaults.colors(
                            indicatorColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                            selectedIconColor = MaterialTheme.colorScheme.primary,
                            selectedTextColor = MaterialTheme.colorScheme.onSurface,
                        ),
                    )
                }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (!browsing && tab != Tab.Settings) Attention(model, hubs) { tab = Tab.Settings }
            Box(Modifier.weight(1f)) {
                when (tab) {
                    Tab.Library -> place?.let { BrowseScreen(model, it) { next -> place = next } }
                        ?: LibraryScreen(model, onFindPeople = { tab = Tab.People }) { place = it }
                    Tab.Search -> SearchScreen(model) { folder ->
                        place = folder
                        tab = Tab.Library
                    }
                    Tab.People -> PeopleScreen(model)
                    Tab.Transfers -> TransfersScreen(model)
                    Tab.Settings -> SettingsScreen(model)
                }
            }
        }
    }
}

/** "Connected", or what's wrong with a hub, as the foot of the desktop's sidebar. */
@Composable
private fun HubState(hubs: List<Hub>, onClick: () -> Unit) {
    if (hubs.isEmpty()) return
    val down = hubs.filter { !it.ready }
    val (text, tone) = when {
        down.isEmpty() -> "Connected" to Tone.On
        down.any { it.problem != null } -> "Needs attention" to Tone.Bad
        down.size == hubs.size -> "Connecting…" to Tone.Warn
        else -> "Some hubs away" to Tone.Warn
    }
    TextButton(onClick, Modifier.padding(end = 4.dp)) { StatusPill(text, tone) }
}

/**
 * Things that stop Communal from working until someone acts, above every screen: this phone
 * removed from the account, a hub whose admin hasn't let us in, or one that refuses us.
 */
@Composable
private fun Attention(model: AppModel, hubs: List<Hub>, onDetails: () -> Unit) {
    val status by model.status.collectAsStateWithLifecycle()
    val account = status?.account
    // Removed from the account: we hold the proof, or every hub refuses our key, as the desktop
    // decides it. (The first device can't be removed; a hub refusing it is something else.)
    val removed = account?.user_id != null && (
        account.revoked ||
            (!account.root_device && hubs.isNotEmpty() && hubs.all { it.problem?.reason == "rejected" })
        )
    if (removed) {
        var asking by remember { mutableStateOf(false) }
        Notice(Tone.Bad, action = { TextButton({ asking = true }) { Text("Start over…") } }) {
            NoticeText(
                if (account!!.revoked) "This phone was removed from your account on another of your devices, so your " +
                    "hubs no longer let it sign in. To use it again, start over and link it with a new code."
                else "None of your hubs will let this phone sign in. That happens when it was removed from your " +
                    "account on another of your devices. To use it again, start over and link it with a new code.",
            )
        }
        if (asking) StartOverDialog { asking = false }
        return
    }
    for (h in hubs.filter { it.problem?.reason == "pending_approval" }) {
        Notice(Tone.Warn) {
            NoticeText(
                "${hubName(h)} lets people in by hand, and its admin hasn’t approved you yet. Until then you can’t " +
                    "search or see people there. Communal checks again by itself.",
            )
        }
    }
    for (h in hubs.filter { it.problem != null && it.problem.reason != "pending_approval" }) {
        Notice(Tone.Bad, action = { TextButton(onDetails) { Text("Details") } }) {
            NoticeText("Can’t connect to ${hubName(h)}: ${h.problem!!.message}")
        }
    }
}

/**
 * A removed phone's identity can never sign in again, so starting over clears the app's data
 * (its key in the Keystore goes with it), as "Clear storage" in Android's settings does. Android
 * closes the app; opened again, it's new and links with a code. Downloads stay where they are.
 */
@Composable
private fun StartOverDialog(onClose: () -> Unit) {
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Start over on this phone?") },
        text = {
            Text(
                "Communal clears its data and closes. Open it again, choose I have Communal, and type a code from " +
                    "Settings › Devices on one of your computers. Files you downloaded stay in Download/Communal. " +
                    "Folders you kept in sync need setting up again.",
            )
        },
        confirmButton = {
            TextButton({ context.getSystemService(ActivityManager::class.java).clearApplicationUserData() }) {
                Text("Start over")
            }
        },
        dismissButton = { TextButton(onClose) { Text("Cancel") } },
    )
}

fun parentOf(path: String): String {
    val trimmed = path.trimEnd('/')
    val i = trimmed.lastIndexOf('/')
    return if (i < 0) "" else trimmed.substring(0, i + 1)
}
