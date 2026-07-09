package com.beatroute.signal

import android.content.Context
import com.beatroute.signal.internal.EligibilityClient
import com.beatroute.signal.internal.FeedbackClient
import com.beatroute.signal.internal.SignalState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.HttpUrl.Companion.toHttpUrl

/**
 * The entire public surface of the Signal SDK.
 *
 * The final surface is exactly [init], [trackEvent], [onScreenEnter], and
 * [onScreenExit]. This task ([init] + state) lands the entry point; the hook
 * bodies arrive in Phase D. Every hook is a silent no-op before [init] and never
 * throws — the SDK must never crash a host that forgot (or chose not) to init.
 */
object Signal {

    /**
     * Resolved runtime state, or `null` before [init] / after teardown.
     * `internal` so same-module tests can assert on initialization.
     */
    internal var state: SignalState? = null

    /**
     * Initialize the SDK. Idempotent: calling again cancels the previous scope and
     * rebuilds state, so a host may safely re-init on identity change.
     *
     * @param context any [Context]; the application context is retained to avoid
     *   leaking an Activity.
     * @param environment fixes the base URL + app key (M3-D12).
     * @param sessionProvider host-owned source of identity, resolved per call (M3-D10).
     * @param baseUrlOverride overrides [environment]'s base URL — for tests / local
     *   dev (e.g. `http://10.0.2.2:3000/`).
     * @param appKeyOverride overrides [environment]'s app key — for tests / local dev.
     */
    fun init(
        context: Context,
        environment: SignalEnvironment,
        sessionProvider: SessionProvider,
        baseUrlOverride: String? = null,
        appKeyOverride: String? = null,
    ) {
        // Idempotent re-init: tear down the previous supervised scope first.
        state?.scope?.cancel()

        val baseUrl = (baseUrlOverride ?: environment.baseUrl).toHttpUrl()
        val appKey = appKeyOverride ?: environment.appKey
        val appContext = context.applicationContext

        // M3-D16: one SDK-owned supervised scope; a single thrown coroutine can
        // never propagate to sibling work or crash the host.
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

        state = SignalState(
            applicationContext = appContext,
            baseUrl = baseUrl,
            appKey = appKey,
            sessionProvider = sessionProvider,
            eligibilityClient = EligibilityClient(baseUrl, appKey),
            feedbackClient = FeedbackClient(baseUrl, appKey),
            scope = scope,
        )
    }

    /**
     * Action hook — signals a meaningful in-app event (e.g. `"order_completion"`).
     * No-op before [init]. Flow logic lands in Phase D.
     */
    fun trackEvent(screenId: String) {
        @Suppress("UNUSED_VARIABLE")
        val s = state ?: return
        // Phase D: eligibility check + sheet trigger.
    }

    /**
     * Screen-enter hook — starts dwell tracking for [screenId].
     * No-op before [init]. Flow logic lands in Phase D.
     */
    fun onScreenEnter(screenId: String) {
        @Suppress("UNUSED_VARIABLE")
        val s = state ?: return
        // Phase D: dwell timer start.
    }

    /**
     * Screen-exit hook — stops dwell tracking for [screenId].
     * No-op before [init]. Flow logic lands in Phase D.
     */
    fun onScreenExit(screenId: String) {
        @Suppress("UNUSED_VARIABLE")
        val s = state ?: return
        // Phase D: dwell timer stop + trigger evaluation.
    }

    /** Same-module visibility for tests: has the SDK been initialized? */
    internal fun isInitialized(): Boolean = state != null

    /** Test-only teardown: cancel the scope and drop state so tests stay isolated. */
    internal fun resetForTest() {
        state?.scope?.cancel()
        state = null
    }
}
