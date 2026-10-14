package dev.communal.spike

import android.app.Application

/** Starts the core once per app process, so it outlives activity recreation. */
class SpikeApp : Application() {
    lateinit var core: CoreProcess
        private set

    override fun onCreate() {
        super.onCreate()
        core = CoreProcess(this).also { it.start { } }
    }
}
