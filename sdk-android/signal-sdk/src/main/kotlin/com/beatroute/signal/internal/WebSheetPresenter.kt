package com.beatroute.signal.internal

import android.content.Context
import com.beatroute.signal.SessionProvider
import com.beatroute.signal.ui.WebViewSheetFragment
import kotlinx.coroutines.CoroutineScope

/**
 * The real, WebView-showing [SheetPresenter] (F2 refit, replacing the native
 * SignalSheetPresenter).
 *
 * Shows [WebViewSheetFragment] on the host's current FragmentManager (via [host]) and
 * hands it a per-sheet [SignalBridge] wired to the precious outbox + local suppression.
 * The fragment loads the bundled web-core in a WebView and forwards the RAW config JSON
 * (GR-2); the bridge routes submit/dismiss into the outbox and records suppression for
 * `(eventName, userId)`.
 *
 * Everything is wrapped so a failure never escapes into the host (F2-D10): a missing
 * host, a show-after-state-loss, or an enqueue failure is swallowed rather than crashing.
 */
internal class WebSheetPresenter(
    private val context: Context,
    private val sessionProvider: SessionProvider,
    private val suppressionCache: SuppressionStore,
    private val clock: () -> Long,
    private val scope: CoroutineScope,
    private val host: FragmentHostProvider,
) : SheetPresenter {

    override fun show(eventName: String, result: EligibilityResult) {
        // No resumed FragmentActivity -> can't show; drop silently, never crash.
        val fm = host.currentFragmentManager() ?: return

        val bridge = SignalBridge(
            context = context,
            eventName = eventName,
            triggerId = result.triggerId,
            sessionProvider = sessionProvider,
            suppressionCache = suppressionCache,
            clock = clock,
            scope = scope,
        )

        val fragment = WebViewSheetFragment.newInstance(result.rawConfigJson)
        fragment.bridge = bridge

        // Showing after the host's state has been saved throws; never let that reach the host.
        runCatching { fragment.show(fm, WebViewSheetFragment.SHEET_TAG) }
    }
}
