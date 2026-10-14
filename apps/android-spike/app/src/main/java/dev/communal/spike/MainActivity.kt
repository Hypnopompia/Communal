package dev.communal.spike

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * EXPERIMENTAL (Android spike). The Compose-over-local-API seam: every action is a call to the
 * core's local API (packages/core/src/api/server.ts), exactly like the desktop renderer.
 */
class MainActivity : ComponentActivity() {
    private lateinit var core: CoreProcess

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        core = (application as SpikeApp).core
        setContent { MaterialTheme { Surface(Modifier.fillMaxSize()) { Screen(core) } } }
    }
}

data class Hit(val name: String, val hash: String, val size: Long, val sources: Int)

@Composable
fun Screen(core: CoreProcess) {
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf("starting core…") }
    var hubUrl by remember { mutableStateOf("wss://10.0.2.2:18443/v1") }
    var code by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    val hits = remember { mutableStateListOf<Hit>() }
    var downloads by remember { mutableStateOf("") }

    suspend fun api(method: String, path: String, body: JSONObject? = null) =
        withContext(Dispatchers.IO) { core.call(method, path, body) }

    LaunchedEffect(Unit) {
        while (true) {
            if (core.apiUrl != null) {
                val s = api("GET", "/v1/status")
                val hubs = s.optJSONArray("hubs")
                val account = s.optJSONObject("account")
                status = "core ready in ${core.readyAfterMs} ms · device ${s.optString("device_id")}\n" +
                    "account ${account?.optString("user_id")} · hubs ${hubs?.length() ?: 0}" +
                    (hubs?.optJSONObject(0)?.let { " (${it.optString("status")})" } ?: "")
                val d = api("GET", "/v1/downloads").optJSONArray("downloads")
                downloads = (0 until (d?.length() ?: 0)).joinToString("\n") {
                    val x = d!!.getJSONObject(it)
                    "${x.optString("name")}: ${x.optString("state")} ${x.optLong("bytes_done")}/${x.optLong("size")}"
                }
            }
            delay(1000)
        }
    }

    Column(Modifier.safeDrawingPadding().padding(16.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Communal (Android spike)", style = MaterialTheme.typography.titleLarge)
        Text(status, style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(hubUrl, { hubUrl = it }, label = { Text("Hub") }, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(code, { code = it }, label = { Text("Link code") }, modifier = Modifier.weight(1f))
            Button(onClick = {
                scope.launch {
                    val r = api("POST", "/v1/account/link", JSONObject()
                        .put("url", hubUrl).put("code", code.trim()).put("device_name", "Android spike"))
                    status = "link: $r"
                }
            }) { Text("Link") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(query, { query = it }, label = { Text("Search") }, modifier = Modifier.weight(1f))
            Button(onClick = {
                scope.launch {
                    val r = api("GET", "/v1/search?q=" + java.net.URLEncoder.encode(query, "UTF-8"))
                    hits.clear()
                    val a = r.optJSONArray("hits")
                    for (i in 0 until (a?.length() ?: 0)) {
                        val h = a!!.getJSONObject(i)
                        hits += Hit(h.optString("name"), h.optString("hash"), h.optLong("size"),
                            h.optJSONArray("sources")?.length() ?: 0)
                    }
                }
            }) { Text("Search") }
        }
        LazyColumn(Modifier.weight(1f)) {
            items(hits) { h ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${h.name}\n${h.size / 1024} KiB · ${h.sources} source(s)", Modifier.weight(1f))
                    Button(onClick = {
                        scope.launch { api("POST", "/v1/downloads", JSONObject().put("hash", h.hash)) }
                    }) { Text("Get") }
                }
            }
        }
        Text(downloads, style = MaterialTheme.typography.bodySmall)
    }
}
