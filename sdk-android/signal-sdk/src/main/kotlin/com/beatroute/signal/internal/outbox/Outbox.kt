package com.beatroute.signal.internal.outbox

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import com.beatroute.signal.internal.FeedbackSender
import java.util.concurrent.TimeUnit

/**
 * Process-global holder for the outbox worker's collaborators.
 *
 * WHY a holder (and not a custom WorkerFactory): the Signal SDK is a guest in the host
 * app's process. It cannot assume it owns the single WorkManager Configuration/WorkerFactory
 * (the host may already provide its own via Configuration.Provider), so registering a custom
 * factory for DI is unreliable. Instead OutboxWorker uses the standard (Context, WorkerParameters)
 * constructor (which the DEFAULT factory can build in production) and pulls its dependencies from
 * this holder, which Signal.init / the Outbox facade populate.
 */
internal object OutboxDependencies {
    @Volatile var dao: OutboxDao? = null

    @Volatile var feedback: FeedbackSender? = null
}

/**
 * Enqueue + schedule facade for the outbox flush worker.
 */
internal object Outbox {
    private const val UNIQUE_WORK_NAME = "signal_outbox_flush"

    /** Persist [entity] to the local queue and schedule a flush. */
    suspend fun enqueueAndSchedule(context: Context, entity: OutboxEntity) {
        OutboxDependencies.dao?.enqueue(entity)
        schedule(context)
    }

    /**
     * Schedule a (network-gated, exponentially-backed-off) flush run.
     *
     * Uses enqueueUniqueWork with APPEND_OR_REPLACE so a flood of enqueues coalesces into a
     * single logical flush chain rather than piling up N redundant workers — the worker already
     * drains the whole queue in one run.
     */
    fun schedule(context: Context) {
        val request = OneTimeWorkRequestBuilder<OutboxWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS,
            )
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
}
