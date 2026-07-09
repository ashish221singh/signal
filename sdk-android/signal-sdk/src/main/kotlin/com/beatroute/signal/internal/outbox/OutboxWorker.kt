package com.beatroute.signal.internal.outbox

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.beatroute.signal.internal.DismissBody
import com.beatroute.signal.internal.ResponseBody
import com.beatroute.signal.internal.SendResult
import com.beatroute.signal.internal.SignalJson
import kotlinx.serialization.decodeFromString

/**
 * Drains the Room outbox, sending each item via the injected [FeedbackSender], and applies
 * the M3-D7 retry/drop/idempotency semantics:
 *
 *  - Success -> delete the row (done; backend dedups on trigger_id so replays are harmless).
 *  - RetryableFailure -> keep the row, increment attempts, and the whole run returns retry()
 *    so WorkManager reschedules with backoff on reconnect.
 *  - Drop -> delete the row (never granted / permanently invalid; don't retry forever).
 *
 * Uses the standard (Context, WorkerParameters) constructor so the default WorkerFactory can
 * build it in production; collaborators come from [OutboxDependencies].
 */
internal class OutboxWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val dao = OutboxDependencies.dao ?: return Result.success()
        val sender = OutboxDependencies.feedback ?: return Result.success()

        var anyRetry = false
        for (item in dao.pending()) {
            // A thrown decode (bad payload) resolves to Drop for that one row; one bad row must
            // never take down the whole worker.
            val outcome: SendResult = try {
                when (item.kind) {
                    "response" ->
                        sender.postResponse(SignalJson.decodeFromString<ResponseBody>(item.payloadJson))
                    "dismiss" ->
                        sender.postDismiss(SignalJson.decodeFromString<DismissBody>(item.payloadJson))
                    // Unknown kind can never succeed -> consume it.
                    else -> SendResult.Drop
                }
            } catch (_: Throwable) {
                SendResult.Drop
            }

            when (outcome) {
                SendResult.Success, SendResult.Drop -> dao.delete(item.id)
                SendResult.RetryableFailure -> {
                    dao.incrementAttempts(item.id)
                    anyRetry = true
                }
            }
        }

        return if (anyRetry) Result.retry() else Result.success()
    }
}
