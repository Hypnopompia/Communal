package io.github.hypnopompia.communal.ui

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FolderShared
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.CoreHost

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

private enum class Tab(val label: String) { Search("Search"), Library("Library"), Transfers("Transfers"), Settings("Settings") }

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
    when {
        ready == null || s == null -> Starting(core)
        s.account.user_id == null || s.hubs.isEmpty() -> Setup(model, snackbar)
        else -> Main(model, snackbar)
    }
}

@Composable
private fun Starting(core: CoreHost.State) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (core is CoreHost.State.Failed) {
                Text("Communal couldn’t start", style = MaterialTheme.typography.titleMedium)
                Text(core.message, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("Trying again…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                CircularProgressIndicator()
                Text("Starting…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** A place in the Library: a device of someone's, and a folder on it ("" is the top). */
data class Place(val hub: String, val device: String, val name: String, val path: String = "")

@Composable
private fun Main(model: AppModel, snackbar: SnackbarHostState) {
    var tab by rememberSaveable { mutableStateOf(Tab.Search) }
    var place by remember { mutableStateOf<Place?>(null) }
    BackHandler(enabled = place != null || tab != Tab.Search) {
        val p = place
        when {
            p != null && p.path.isNotEmpty() -> place = p.copy(path = parentOf(p.path))
            p != null -> place = null
            else -> tab = Tab.Search
        }
    }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar {
                for (t in Tab.entries) {
                    NavigationBarItem(
                        selected = t == tab,
                        onClick = {
                            if (t == Tab.Library && tab == Tab.Library) place = null
                            tab = t
                        },
                        icon = {
                            Icon(
                                when (t) {
                                    Tab.Search -> Icons.Default.Search
                                    Tab.Library -> Icons.Default.FolderShared
                                    Tab.Transfers -> Icons.Default.Download
                                    Tab.Settings -> Icons.Default.Settings
                                },
                                contentDescription = null,
                            )
                        },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad)) {
            when (tab) {
                Tab.Search -> SearchScreen(model)
                Tab.Library -> place?.let { BrowseScreen(model, it) { next -> place = next } }
                    ?: LibraryScreen(model) { place = it }
                Tab.Transfers -> TransfersScreen(model)
                Tab.Settings -> SettingsScreen(model)
            }
        }
    }
}

fun parentOf(path: String): String {
    val trimmed = path.trimEnd('/')
    val i = trimmed.lastIndexOf('/')
    return if (i < 0) "" else trimmed.substring(0, i + 1)
}
