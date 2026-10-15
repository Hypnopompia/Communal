package io.github.hypnopompia.communal.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.BuildConfig
import io.github.hypnopompia.communal.Hub
import io.github.hypnopompia.communal.R
import io.github.hypnopompia.communal.SyncWorker

private const val SITE = "https://hypnopompia.github.io/Communal/"
private const val SOURCE = "https://github.com/Hypnopompia/Communal"

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(model: AppModel) {
    val status by model.status.collectAsStateWithLifecycle()
    val settings by model.settings.value.collectAsStateWithLifecycle()
    val remotes by model.remotes.collectAsStateWithLifecycle()
    val update by model.update.collectAsStateWithLifecycle()
    val library by model.library.collectAsStateWithLifecycle()
    val connections by model.connections.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var leaving by remember { mutableStateOf<Hub?>(null) }
    var joining by remember { mutableStateOf(false) }
    var licences by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { model.refreshRemotes() }
    val view = { url: String -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        update?.let { u ->
            Notice(Tone.On, Modifier.padding(top = 8.dp), action = {
                Button({ view(u.apk) }) { Text("Download the update") }
            }) {
                Text("Communal ${u.version} is out", style = MaterialTheme.typography.titleMedium)
                NoticeText("Download it, then open the file to install it over this version. Your account and settings stay.")
            }
        }

        SectionTitle("Hubs") { TextButton({ joining = true }) { Text("Join another") } }
        PanelRows(status?.hubs.orEmpty()) { h ->
            Item(
                hubName(h),
                leading = { Icon(Glyphs.Hub, null, Modifier.size(24.dp)) },
                extra = {
                    StatusPill(
                        if (h.ready) "Connected" else h.problem?.message ?: "Connecting…",
                        when {
                            h.ready -> Tone.On
                            h.problem?.reason == "pending_approval" -> Tone.Warn
                            h.problem != null -> Tone.Bad
                            else -> Tone.Warn
                        },
                        Modifier.padding(top = 2.dp),
                    )
                },
                trailing = { TextButton({ leaving = h }) { Text("Leave") } },
            )
        }

        SectionTitle("Your computers")
        Hint(
            "This phone can ask a computer of yours to download files and keep folders in sync, so they’re waiting " +
                "there when you get back. Turn it on in the computer’s Settings › Downloads, or with " +
                "communal remote allow on a server.",
        )
        if (remotes.isEmpty()) {
            Panel { Item("None yet", sub = "Link this phone to an account that has a computer.", leading = { Icon(Glyphs.Device, null) }) }
        }
        PanelRows(remotes) { r ->
            Item(
                r.device.name,
                leading = { PlatformIcon(r.device.platform, 24.dp) },
                extra = {
                    StatusPill(
                        when {
                            !r.device.online -> "Offline"
                            r.allowed == true -> "Takes downloads from this phone"
                            r.allowed == false -> "Doesn’t take downloads from this phone yet"
                            else -> "Checking…"
                        },
                        when {
                            !r.device.online -> Tone.Off
                            r.allowed == true -> Tone.On
                            else -> Tone.Warn
                        },
                        Modifier.padding(top = 2.dp),
                    )
                },
            )
        }

        SectionTitle("Keeping folders in sync")
        Hint("Android limits apps in the background, so Communal catches up every few hours, and whenever you open it.")
        Panel {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Catch up", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((h, label) in listOf(1 to "Hourly", 6 to "Every 6 hours", 24 to "Daily", 0 to "Only when open")) {
                        val on = settings.syncHours == h
                        FilterChip(
                            on,
                            { SyncWorker.schedule(context, model.settings.update { it.copy(syncHours = h) }) },
                            { Text(label) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = MaterialTheme.colorScheme.primary,
                                selectedLabelColor = MaterialTheme.colorScheme.onPrimary,
                            ),
                            border = FilterChipDefaults.filterChipBorder(true, on, borderColor = Brand.tones.line),
                        )
                    }
                }
            }
            PanelDivider()
            Item(
                "Only on Wi-Fi",
                sub = "Don’t use mobile data to catch up in the background",
                trailing = {
                    Switch(settings.wifiOnly, { on -> SyncWorker.schedule(context, model.settings.update { it.copy(wifiOnly = on) }) })
                },
            )
        }

        SectionTitle("This phone")
        Panel {
            Item(
                "Downloads",
                sub = "Saved in Download/Communal, where music players and other apps find them",
                leading = { FolderIcon(32.dp) },
            )
            PanelDivider()
            Item(
                "Account key",
                sub = status?.account?.fingerprint?.chunked(4)?.take(4)?.joinToString(" ")?.plus("…") ?: "—",
                leading = { Icon(Glyphs.Shield, null) },
            )
        }

        SectionTitle("About")
        Panel {
            // The version gets its own line: next to a button it was cut short on narrow phones.
            Item("Communal", sub = "Version ${BuildConfig.VERSION_NAME}", leading = { Mark(32.dp) })
            PanelDivider()
            Item("Check for updates", leading = { Icon(Glyphs.Update, null) }, onClick = { model.checkForUpdate() })
            PanelDivider()
            Item("Website", sub = "hypnopompia.github.io/Communal", leading = { Icon(Glyphs.Globe, null) }, onClick = { view(SITE) })
            PanelDivider()
            Item("Source code", sub = "github.com/Hypnopompia/Communal", leading = { Icon(Glyphs.Open, null) }, onClick = { view(SOURCE) })
            PanelDivider()
            Item("Open-source licences", leading = { Icon(Glyphs.Info, null) }, onClick = { licences = true })
        }
        Box(Modifier.height(32.dp))
    }

    leaving?.let { h ->
        AlertDialog(
            onDismissRequest = { leaving = null },
            title = { Text("Leave ${hubName(h)}?") },
            text = { Text("This phone stops using that hub. Your account and your computers stay on it.") },
            confirmButton = {
                TextButton({
                    leaving = null
                    model.act("Left ${hubName(h)}") { model.api.leave(h.id) }
                }) { Text("Leave") }
            },
            dismissButton = { TextButton({ leaving = null }) { Text("Cancel") } },
        )
    }
    if (joining) {
        val me = status?.account?.user_id
        val myName = me?.let { Names(connections, library).person(it)?.display_name }
            ?: library.firstOrNull { it.user.user_id == me }?.user?.display_name
        JoinHubDialog(model, myName.orEmpty()) { joining = false }
    }
    if (licences) {
        val text = remember {
            context.resources.openRawResource(R.raw.font_license).bufferedReader().use { it.readText() }
        }
        AlertDialog(
            onDismissRequest = { licences = false },
            title = { Text("Open-source licences") },
            text = {
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "Communal is open source. It runs Node.js and uses libraries under their own licences; see the source code for the full list.",
                    )
                    Text("Atkinson Hyperlegible Next", style = MaterialTheme.typography.titleSmall)
                    Text(text, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp)
                }
            },
            confirmButton = { TextButton({ licences = false }) { Text("Close") } },
        )
    }
}

/** Another hub, with the same account (ADR 0007): the desktop's "Join another hub". */
@Composable
private fun JoinHubDialog(model: AppModel, myName: String, onClose: () -> Unit) {
    var url by remember { mutableStateOf("") }
    var name by remember { mutableStateOf(myName) }
    var device by remember { mutableStateOf(Build.MODEL ?: "Phone") }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Join another hub") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    url, { url = it }, Modifier.fillMaxWidth(),
                    label = { Text("Hub address") },
                    placeholder = { Text("hub.example.com") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Your name there") }, singleLine = true)
                OutlinedTextField(device, { device = it }, Modifier.fillMaxWidth(), label = { Text("This phone’s name") }, singleLine = true)
            }
        },
        confirmButton = {
            TextButton(
                {
                    busy = true
                    model.act(null) {
                        try {
                            model.api.join(hubUrl(url), name.trim(), device.trim())
                            model.message.value = "Joined"
                            onClose()
                        } finally {
                            busy = false
                            model.reloadStatus()
                        }
                    }
                },
                enabled = !busy && url.isNotBlank() && name.isNotBlank() && device.isNotBlank(),
            ) { Text(if (busy) "Joining…" else "Join") }
        },
        dismissButton = { TextButton(onClose) { Text("Cancel") } },
    )
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        Modifier.padding(start = 20.dp, end = 20.dp, bottom = 10.dp),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
