package io.github.hypnopompia.communal.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.hypnopompia.communal.BuildConfig
import io.github.hypnopompia.communal.Hub
import io.github.hypnopompia.communal.SyncWorker

@Composable
fun SettingsScreen(model: AppModel) {
    val status by model.status.collectAsStateWithLifecycle()
    val settings by model.settings.value.collectAsStateWithLifecycle()
    val remotes by model.remotes.collectAsStateWithLifecycle()
    val update by model.update.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var leaving by remember { mutableStateOf<Hub?>(null) }
    LaunchedEffect(Unit) { model.refreshRemotes() }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
        update?.let { u ->
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Communal ${u.version} is out", style = MaterialTheme.typography.titleMedium)
                Text("Download it, then open the file to install it over this version. Your account and settings stay.")
                Button({ context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u.apk))) }) { Text("Download the update") }
            }
            HorizontalDivider()
        }

        Title("Hubs")
        for (h in status?.hubs.orEmpty()) {
            ListItem(
                headlineContent = { Text(hubName(h)) },
                supportingContent = { Text(if (h.ready) "Connected" else h.problem?.message ?: "Connecting…") },
                leadingContent = { Icon(Icons.Default.Hub, null) },
                trailingContent = { TextButton({ leaving = h }) { Text("Leave") } },
            )
        }

        Title("Your computers")
        Text(
            "This phone can ask a computer of yours to download files and keep folders in sync, so they’re " +
                "waiting there when you get back. Turn it on in the computer’s Settings › Downloads, or with `communal remote allow` on a server.",
            Modifier.padding(horizontal = 16.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (remotes.isEmpty()) {
            Text("None yet: link this phone to an account that has a computer.", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.outline)
        }
        for (r in remotes) {
            ListItem(
                headlineContent = { Text(r.device.name) },
                supportingContent = {
                    Text(
                        when {
                            !r.device.online -> "Offline"
                            r.allowed == true -> "Takes downloads from this phone"
                            r.allowed == false -> "Doesn’t take downloads from this phone yet"
                            else -> "Checking…"
                        },
                    )
                },
                leadingContent = { Icon(platformIcon(r.device.platform), null) },
            )
        }

        Title("Keeping folders in sync")
        Text(
            "Android limits apps in the background, so Communal catches up every few hours, and whenever you open it.",
            Modifier.padding(horizontal = 16.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for ((h, label) in listOf(1 to "Hourly", 6 to "Every 6 hours", 24 to "Daily", 0 to "When open")) {
                FilterChip(settings.syncHours == h, {
                    SyncWorker.schedule(context, model.settings.update { it.copy(syncHours = h) })
                }, { Text(label) })
            }
        }
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Only on Wi-Fi", Modifier.weight(1f))
            Switch(settings.wifiOnly, { on -> SyncWorker.schedule(context, model.settings.update { it.copy(wifiOnly = on) }) })
        }

        Title("This phone")
        Text(
            "Downloads go to Download/Communal, where music players and other apps find them.\n" +
                "Account ${status?.account?.fingerprint?.chunked(4)?.take(4)?.joinToString(" ") ?: "—"}…\n" +
                "Version ${BuildConfig.VERSION_NAME}",
            Modifier.padding(horizontal = 16.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedButton({ model.checkForUpdate() }, Modifier.padding(16.dp)) { Text("Check for updates") }
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
}

@Composable
private fun Title(text: String) {
    Text(
        text,
        Modifier.padding(start = 16.dp, top = 20.dp, bottom = 4.dp),
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
    )
}
