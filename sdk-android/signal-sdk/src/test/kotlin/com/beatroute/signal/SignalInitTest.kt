package com.beatroute.signal

import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SignalInitTest {

    private val provider = object : SessionProvider {
        override fun userId(): String = "u1"
        override fun clientId(): String = "c1"
        override fun repTenureDays(): Int? = 30
    }

    @After
    fun tearDown() {
        // Reset the global object state so tests do not leak into one another.
        Signal.resetForTest()
    }

    @Test
    fun `init stores config and marks initialized`() {
        val ctx = RuntimeEnvironment.getApplication()

        Signal.init(
            context = ctx,
            environment = SignalEnvironment.STAGING,
            sessionProvider = provider,
            baseUrlOverride = "http://localhost/",
        )

        assertTrue(Signal.isInitialized())
    }

    @Test
    fun `hook before init is a silent no-op and never throws`() {
        // No init() called: state is null.
        assertFalse(Signal.isInitialized())

        // Must not throw.
        Signal.trackEvent("order_completion")

        // Still uninitialized after the no-op hook.
        assertFalse(Signal.isInitialized())
    }

    @Test
    fun `init is idempotent — calling twice does not throw and stays initialized`() {
        val ctx = RuntimeEnvironment.getApplication()

        Signal.init(
            context = ctx,
            environment = SignalEnvironment.STAGING,
            sessionProvider = provider,
            baseUrlOverride = "http://localhost/",
        )
        Signal.init(
            context = ctx,
            environment = SignalEnvironment.PRODUCTION,
            sessionProvider = provider,
            baseUrlOverride = "http://localhost/",
        )

        assertTrue(Signal.isInitialized())
    }
}
