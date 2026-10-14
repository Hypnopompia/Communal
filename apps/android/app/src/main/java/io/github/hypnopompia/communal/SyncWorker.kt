package io.github.hypnopompia.communal

import android.content.Context
import android.content.pm.ServiceInfo
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Background catch-up (ADR 0023): every few hours, run the core for a short window so folders
 * you follow pick up what changed (subscriptions resume from their cursor) and queued downloads
 * try their sources again. It runs as WorkManager foreground work, the one way Android 12+ lets
 * background work keep a process going, and stays longer only while a download is moving.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as CommunalApp
        CoreService.channel(app)
        setForeground(info("Catching up…"))
        app.keeper.hold(HOLDER)
        try {
            app.keeper.untilIdle(System.currentTimeMillis() + WINDOW_MS, { false }) {
                setForegroundAsync(info(it))
            }
        } finally {
            app.keeper.release(HOLDER)
        }
        return Result.success()
    }

    private fun info(text: String) = ForegroundInfo(
        NOTE_ID,
        CoreService.note(applicationContext, text),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    )

    companion object {
        private const val NAME = "sync"
        private const val HOLDER = "sync"
        private const val NOTE_ID = 2
        private const val WINDOW_MS = 5 * 60_000L

        /** (Re)schedules the catch-up from the settings; `syncHours = 0` turns it off. */
        fun schedule(context: Context, settings: Settings) {
            val wm = WorkManager.getInstance(context)
            if (settings.syncHours == 0) {
                wm.cancelUniqueWork(NAME)
                return
            }
            val req = PeriodicWorkRequestBuilder<SyncWorker>(settings.syncHours.toLong(), TimeUnit.HOURS)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                        .setRequiresBatteryNotLow(true)
                        .build(),
                )
                .build()
            wm.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}
