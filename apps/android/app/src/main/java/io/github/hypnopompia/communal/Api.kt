package io.github.hypnopompia.communal

import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/*
 * The core's local API as the app sees it (packages/core/src/api/server.ts). Keep these types in
 * step with it, as the desktop's renderer api.ts does.
 */

@Serializable data class Status(val device_id: String, val account: Identity, val hubs: List<Hub>)

@Serializable data class Identity(val device_id: String, val user_id: String? = null, val fingerprint: String? = null)

@Serializable
data class Hub(
    val id: String,
    val url: String,
    val name: String? = null,
    val ready: Boolean,
    val problem: Problem? = null,
    val registered: Boolean = false,
    val user_id: String? = null,
)

@Serializable data class Problem(val reason: String, val message: String)

@Serializable data class Person(val user_id: String, val display_name: String, val fingerprint: String, val verified: Boolean = false)

@Serializable
data class LibraryDevice(
    val hub: String,
    val device_id: String,
    val device_name: String,
    val user: Person,
    val online: Boolean,
    val seen: String,
)

@Serializable data class Library(val devices: List<LibraryDevice>)

@Serializable
data class Meta(
    val width: Int? = null,
    val height: Int? = null,
    val duration: Double? = null,
    val artist: String? = null,
    val album: String? = null,
    val title: String? = null,
    val pages: Int? = null,
)

@Serializable
data class Source(val hub: String, val device_id: String, val owner: String, val path: String, val online: Boolean, val seen: String)

@Serializable
data class Hit(
    val hash: String,
    val name: String,
    val size: Long,
    val mime: String,
    val kind: String,
    val meta: Meta = Meta(),
    val thumb: Boolean = false,
    val sources: List<Source>,
)

@Serializable data class SearchResult(val hits: List<Hit>)

@Serializable
data class Entry(
    val path: String,
    val size: Long,
    val mime: String,
    val kind: String,
    val meta: Meta = Meta(),
    val thumb: Boolean = false,
    val hash: String? = null,
) {
    val name: String get() = path.substringAfterLast('/')
}

@Serializable data class Dir(val name: String)

@Serializable data class Listing(val online: Boolean, val dirs: List<Dir>, val files: List<Entry>)

@Serializable data class Diagnosis(val message: String, val tips: List<String> = emptyList())

@Serializable
data class Transfer(
    val id: String,
    val hash: String,
    val name: String,
    val size: Long? = null,
    val state: String,
    val bytes_done: Long,
    val error: String? = null,
    val final_path: String? = null,
    val requested_by: String? = null,
    val diagnosis: Diagnosis? = null,
    val updated_at: Long,
)

@Serializable data class Transfers(val downloads: List<Transfer>)

@Serializable data class FileCounts(val pending: Int = 0, val done: Int = 0, val failed: Int = 0, val removed: Int = 0)

@Serializable
data class Subscription(
    val id: String,
    val hub: String,
    val device_id: String,
    val path: String,
    val dest_dir: String,
    val mirror_deletes: Boolean,
    val paused: Boolean,
    val status: String,
    val sync: Boolean = false,
    val files: FileCounts = FileCounts(),
)

@Serializable data class Subscriptions(val subscriptions: List<Subscription>)

@Serializable
data class Device(
    val device_id: String,
    val name: String,
    val platform: String,
    val root: Boolean,
    val this_device: Boolean,
    val revoked: Boolean,
)

@Serializable data class Devices(val devices: List<Device>)

/** Another device of this account that remote requests can go to (ADR 0023). */
@Serializable data class RemoteDevice(val device_id: String, val name: String, val platform: String, val online: Boolean)

@Serializable data class RemoteDevices(val devices: List<RemoteDevice>)

@Serializable
data class RemoteTransfer(
    val id: String,
    val name: String,
    val size: Long? = null,
    val bytes_done: Long,
    val state: String,
    val error: String? = null,
    val requested_by: String? = null,
    val updated_at: Long,
)

@Serializable data class RemoteTransfers(val transfers: List<RemoteTransfer>)

@Serializable data class Hello(val allowed: Boolean, val destinations: List<String> = listOf("Downloads"))

@Serializable data class LinkResult(val user_id: String, val fingerprint: String)

/** A failed API call, with the core's error code and its message for people. */
class ApiError(val status: Int, val code: String, message: String) : IOException(message)

class Api(private val host: CoreHost) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        // Link and remote requests wait on another device.
        .readTimeout(150, TimeUnit.SECONDS)
        .build()

    private suspend fun base(): String =
        host.state.filterIsInstance<CoreHost.State.Ready>().first().url

    private suspend fun call(method: String, path: String, body: JsonElement? = null): String =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url(base() + path)
                .header("Authorization", "Bearer ${host.token}")
                .method(method, body?.toString()?.toRequestBody(JSON))
                .build()
            http.newCall(req).execute().use { res -> text(res) }
        }

    private fun text(res: Response): String {
        val s = res.body?.string().orEmpty()
        if (res.isSuccessful) return s
        val o = runCatching { json.parseToJsonElement(s).jsonObject }.getOrNull()
        throw ApiError(
            res.code,
            o?.get("error")?.jsonPrimitive?.content ?: "error",
            o?.get("message")?.jsonPrimitive?.content ?: "Something went wrong (${res.code})",
        )
    }

    private suspend inline fun <reified T> get(path: String): T = json.decodeFromString(call("GET", path))

    private fun q(v: String) = URLEncoder.encode(v, "UTF-8")

    suspend fun status(): Status = get("/v1/status")
    suspend fun library(): Library = get("/v1/library")
    suspend fun devices(): Devices = get("/v1/devices")

    suspend fun search(query: String, kind: String? = null): SearchResult =
        get("/v1/search?q=${q(query)}&limit=100" + (kind?.let { "&kind=$it" } ?: ""))

    suspend fun browse(hub: String, device: String, path: String): Listing =
        get("/v1/browse?hub=${q(hub)}&device=${q(device)}&path=${q(path)}")

    /** Fetches a batch of thumbnails into the core's cache; says which exist. */
    suspend fun fetchThumbs(hub: String, device: String, hashes: List<String>): Map<String, Boolean> {
        val body = buildJsonObject {
            put("hub", hub)
            put("device", device)
            putJsonArray("hashes") { hashes.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
            put("size", 320)
        }
        val o = json.parseToJsonElement(call("POST", "/v1/thumbs", body)).jsonObject["thumbs"]!!.jsonObject
        return o.mapValues { it.value.jsonPrimitive.content == "true" }
    }

    /** A cached thumbnail's WebP bytes, or null. */
    suspend fun thumb(hash: String): ByteArray? = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(base() + "/v1/thumbs/$hash?size=320")
            .header("Authorization", "Bearer ${host.token}")
            .build()
        http.newCall(req).execute().use { if (it.isSuccessful) it.body?.bytes() else null }
    }

    suspend fun downloads(): Transfers = get("/v1/downloads")

    suspend fun download(hash: String, name: String?) {
        call("POST", "/v1/downloads", buildJsonObject {
            put("hash", hash)
            name?.let { put("name", it) }
        })
    }

    suspend fun downloadFolder(hub: String, device: String, path: String) {
        call("POST", "/v1/downloads/folder", buildJsonObject {
            put("hub", hub)
            put("device", device)
            put("path", path)
        })
    }

    suspend fun cancel(id: String) { call("DELETE", "/v1/downloads/$id") }
    suspend fun clearFinished() { call("POST", "/v1/downloads/clear", JsonObject(emptyMap())) }

    suspend fun subscriptions(): Subscriptions = get("/v1/subscriptions")

    suspend fun subscribe(hub: String, device: String, path: String, mirrorDeletes: Boolean) {
        call("POST", "/v1/subscriptions", buildJsonObject {
            put("hub", hub)
            put("device", device)
            put("path", path)
            put("mirror_deletes", mirrorDeletes)
        })
    }

    suspend fun setPaused(id: String, paused: Boolean) {
        call("PUT", "/v1/subscriptions/$id", buildJsonObject { put("paused", paused) })
    }

    suspend fun unsubscribe(id: String) { call("DELETE", "/v1/subscriptions/$id") }

    suspend fun link(url: String, code: String, deviceName: String): LinkResult =
        json.decodeFromString(call("POST", "/v1/account/link", buildJsonObject {
            put("url", url)
            put("code", code)
            put("device_name", deviceName)
        }))

    suspend fun join(url: String, displayName: String, deviceName: String) {
        call("POST", "/v1/hubs", buildJsonObject {
            put("url", url)
            put("display_name", displayName)
            put("device_name", deviceName)
        })
    }

    suspend fun leave(hub: String) { call("DELETE", "/v1/hubs/${q(hub)}") }

    // ── remote control (ADR 0023) ──

    suspend fun remoteDevices(): RemoteDevices = get("/v1/remote/devices")

    private suspend fun remote(device: String, request: JsonObject): JsonElement =
        json.parseToJsonElement(call("POST", "/v1/remote/${q(device)}", request)).jsonObject["result"]!!

    /**
     * Whether that computer takes requests from this phone (its setting), and the names of its
     * destinations (ADR 0018), its downloads folder first. Names only: never its folders.
     */
    suspend fun remoteHello(device: String): Hello =
        json.decodeFromJsonElement(Hello.serializer(), remote(device, buildJsonObject { put("op", "hello") }))

    suspend fun remoteDownload(device: String, hash: String, name: String?, destination: String? = null) {
        remote(device, buildJsonObject {
            put("op", "download")
            put("hash", hash)
            name?.let { put("name", it) }
            destination?.let { put("destination", it) }
        })
    }

    suspend fun remoteDownloadFolder(device: String, hubUrl: String, owner: String, path: String, destination: String? = null) {
        remote(device, buildJsonObject {
            put("op", "download_folder")
            put("hub", hubUrl)
            put("device_id", owner)
            put("path", path)
            destination?.let { put("destination", it) }
        })
    }

    suspend fun remoteSubscribe(
        device: String,
        hubUrl: String,
        owner: String,
        path: String,
        mirrorDeletes: Boolean,
        destination: String? = null,
    ) {
        remote(device, buildJsonObject {
            put("op", "subscribe")
            put("hub", hubUrl)
            put("device_id", owner)
            put("path", path)
            put("mirror_deletes", mirrorDeletes)
            destination?.let { put("destination", it) }
        })
    }

    suspend fun remoteTransfers(device: String): List<RemoteTransfer> =
        json.decodeFromJsonElement(RemoteTransfers.serializer(), remote(device, buildJsonObject { put("op", "transfers") })).transfers

    suspend fun remoteCancel(device: String, id: String) {
        remote(device, buildJsonObject {
            put("op", "cancel")
            put("id", id)
        })
    }

    /**
     * Topics the core says changed (`/v1/events`): screens refetch what they show. The flow ends
     * with an error when the socket drops; collectors retry it.
     */
    fun events(): Flow<Set<String>> = callbackFlow {
        val url = base().replaceFirst("http", "ws") + "/v1/events"
        val req = Request.Builder().url(url).header("Authorization", "Bearer ${host.token}").build()
        val ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // Anything may have changed while we weren't listening.
                trySend(setOf("*"))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val topics = runCatching {
                    json.parseToJsonElement(text).jsonObject["topics"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
                }.getOrDefault(emptySet())
                trySend(topics)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                close(t)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                close(IOException("events closed"))
            }
        })
        awaitClose { ws.close(1000, null) }
    }

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}
