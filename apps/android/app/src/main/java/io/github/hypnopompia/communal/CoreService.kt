package io.github.hypnopompia.communal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import io.github.hypnopompia.communal.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the core running while the app is open, and afterwards while a download is still moving
 * (ADR 0023). Android only lets a background app keep a process going as a foreground service
 * with a notification, and caps `dataSync` services at about 6 hours a day, so it stops a couple
 * of minutes after the last download moved. Background catch-up is SyncWorker's job.
 */
class CoreService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loop: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as CommunalApp
        channel(this)
        startForeground(NOTE_ID, note(this, "Connecting…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        app.keeper.hold(HOLDER)
        if (loop?.isActive != true) {
            loop = scope.launch {
                app.keeper.untilIdle(0, ::foreground) { update(it) }
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun foreground() =
        ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    private fun update(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTE_ID, note(this, text))
    }

    override fun onDestroy() {
        scope.cancel()
        (application as CommunalApp).keeper.release(HOLDER)
        super.onDestroy()
    }

    companion object {
        private const val HOLDER = "service"
        const val CHANNEL = "core"
        const val NOTE_ID = 1

        /** Starts (or keeps) the core while the app is open. */
        fun ensure(context: Context) {
            context.startForegroundService(Intent(context, CoreService::class.java))
        }

        fun note(context: Context, text: String): Notification {
            val open = PendingIntent.getActivity(
                context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
            )
            return Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Communal")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .build()
        }

        fun channel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) == null)
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL, "Downloads and sync", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Shown while Communal is downloading or catching up with folders you follow"
                    },
                )
        }
    }
}
