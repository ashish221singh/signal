package com.beatroute.signal.internal

import android.content.Context
import com.beatroute.signal.SessionProvider
import com.beatroute.signal.internal.outbox.Outbox
import com.beatroute.signal.internal.outbox.OutboxEntity
import com.beatroute.signal.ui.SignalBottomSheetFragment
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString

/**
 * The real, fragment-showing [SheetPresenter] (Task G.3).
 *
 * Shows [SignalBottomSheetFragment] on the host's current [androidx.fragment.app.FragmentManager]
 * (via [host]) and bridges the sheet's submit / dismiss callbacks into the PRECIOUS outbox
 * (M3-D7: `/response` and `/dismiss` are never fire-and-forget — they persist to Room and flush
 * via WorkManager). After ANY completed interaction (submit OR dismiss) it records local
 * suppression for `(screenId, clientId)` (M3-D9).
 *
 * Everything is wrapped so a failure never escapes into the host (M3-D16): a missing host,
 * a show-after-state-loss, or an enqueue failure is swallowed rather than crashing the app.
 */
internal class SignalSheetPresenter(
    private val context: Context,
    private val sessionProvider: SessionProvider,
    private val suppressionCache: SuppressionStore,
    private val clock: () -> Long,
    private val scope: CoroutineScope,
    private val imageUploader: ImageUploader,
    private val host: FragmentHostProvider,
) : SheetPresenter {

    override fun show(screenId: String, config: EligibilityConfig) {
        // No resumed FragmentActivity -> can't show; drop silently, never crash.
        val fm = host.currentFragmentManager() ?: return

        val fragment = SignalBottomSheetFragment.newInstance(
            SignalJson.encodeToString(config),
        )
        fragment.imageUploader = imageUploader
        fragment.onSubmit = { response -> handleSubmit(screenId, response) }
        fragment.onDismiss = { handleDismiss(screenId, config) }

        // Showing after the host's state has been saved throws; never let that reach the host.
        runCatching { fragment.show(fm, SHEET_TAG) }
    }

    /**
     * Bridge a submitted [ResponseBody] into the outbox. Patches identity the fragment
     * couldn't know (rep tenure); trigger_id / device_os / app_version / timestamps are
     * already filled by the fragment. Then record local suppression (M3-D9).
     */
    private fun handleSubmit(screenId: String, response: ResponseBody) {
        val finalResponse = response.copy(repTenureDays = sessionProvider.repTenureDays())
        scope.launch {
            runCatching {
                Outbox.enqueueAndSchedule(
                    context,
                    OutboxEntity(
                        kind = "response",
                        triggerId = finalResponse.triggerId,
                        payloadJson = SignalJson.encodeToString(finalResponse),
                        createdAt = clock(),
                    ),
                )
                suppressionCache.recordInteraction(screenId, sessionProvider.clientId(), clock())
            }
        }
    }

    /**
     * Bridge a user-driven dismissal into the outbox as a `/dismiss` (M3-D7), then record
     * local suppression (M3-D9). shownAt is approximated at handling time — the wire only
     * needs a plausible window, and the sheet was on screen moments ago.
     */
    private fun handleDismiss(screenId: String, config: EligibilityConfig) {
        val now = clock()
        val dismiss = DismissBody(
            triggerId = config.triggerId,
            shownAt = Instant.ofEpochMilli(now).toString(),
            dismissedAt = Instant.ofEpochMilli(now).toString(),
        )
        scope.launch {
            runCatching {
                Outbox.enqueueAndSchedule(
                    context,
                    OutboxEntity(
                        kind = "dismiss",
                        triggerId = dismiss.triggerId,
                        payloadJson = SignalJson.encodeToString(dismiss),
                        createdAt = now,
                    ),
                )
                suppressionCache.recordInteraction(screenId, sessionProvider.clientId(), clock())
            }
        }
    }

    private companion object {
        const val SHEET_TAG = "signal_sheet"
    }
}
