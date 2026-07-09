package com.beatroute.signal

/**
 * Host-provided source of the current session identity.
 *
 * The SDK resolves these values internally, per call, whenever a hook needs
 * them (M3-D10). Integrators never pass `user_id` / `client_id` / `rep_tenure_days`
 * into the hook methods — they supply this provider once at [Signal.init] and the
 * SDK pulls fresh values on demand.
 */
interface SessionProvider {
    /** Stable identifier for the signed-in user (sales rep). */
    fun userId(): String

    /** Identifier for the client/customer account in the current context. */
    fun clientId(): String

    /**
     * Days since the rep was onboarded, or `null` when unknown.
     *
     * When `null`, the backend fails closed on tenure-gated campaigns rather than
     * assuming the rep is eligible.
     */
    fun repTenureDays(): Int?
}
