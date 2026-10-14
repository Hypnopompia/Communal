package io.github.hypnopompia.communal

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

/** The app's single instances: the device key, the core and its API, and the phone's settings. */
class CommunalApp : Application() {
    lateinit var keys: DeviceKeys
    lateinit var core: CoreHost
    lateinit var keeper: Keeper
    lateinit var api: Api
    lateinit var settings: SettingsStore
    lateinit var media: MediaIndex
    lateinit var updates: Updates

    override fun onCreate() {
        super.onCreate()
        keys = DeviceKeys(this)
        media = MediaIndex(this)
        core = CoreHost(this, keys) { media.forget(it) }
        keeper = Keeper(this)
        api = Api(core)
        settings = SettingsStore(this)
        updates = Updates(this)
        SyncWorker.schedule(this, settings.value.value)
        // The core runs whenever the app is open; CoreService keeps it going in the background
        // only while a download moves, and SyncWorker opens short catch-up windows.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                CoreService.ensure(this@CommunalApp)
            }
        })
    }
}
