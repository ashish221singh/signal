package com.beatroute.signal

import com.beatroute.signal.internal.EligibilityConfig
import com.beatroute.signal.internal.EligibilitySource
import com.beatroute.signal.internal.SheetPresenter
import com.beatroute.signal.internal.SignalState
import com.beatroute.signal.internal.SuppressionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class TrackEventTest {

    private val fixedNow = 1_700_000_000_000L

    private fun config(triggerId: String = "trig-1") = EligibilityConfig(
        triggerId = triggerId,
        campaignId = "camp-1",
        metricType = "csat",
        header = "How was it?",
        ratingType = "star",
        ratingScaleMax = 5,
        positiveThreshold = 4,
        chipsOnNegative = listOf("Slow"),
        otherRequiresText = true,
        otherAllowsImage = true,
        onPositiveAction = "none",
        skipEnabled = true,
    )

    private class FakeSession(
        private val userId: String = "user-42",
        private val clientId: String = "client-7",
        private val repTenure: Int? = 90,
    ) : SessionProvider {
        override fun userId(): String = userId
        override fun clientId(): String = clientId
        override fun repTenureDays(): Int? = repTenure
    }

    private class FakeEligibilitySource(
        private val result: EligibilityConfig? = null,
        private val throwError: Boolean = false,
    ) : EligibilitySource {
        var callCount = 0
        var lastScreenId: String? = null
        var lastUserId: String? = null
        var lastClientId: String? = null
        var lastRepTenure: Int? = null
        var repTenureWasSet = false

        override suspend fun check(
            screenId: String,
            userId: String,
            clientId: String,
            repTenureDays: Int?,
        ): EligibilityConfig? {
            callCount++
            lastScreenId = screenId
            lastUserId = userId
            lastClientId = clientId
            lastRepTenure = repTenureDays
            repTenureWasSet = true
            if (throwError) throw RuntimeException("boom")
            return result
        }
    }

    private class FakeSuppressionStore(
        private val suppressed: Boolean = false,
    ) : SuppressionStore {
        var isSuppressedCalled = false
        var recordCalled = false

        override suspend fun isSuppressed(screenId: String, clientId: String, nowMs: Long): Boolean {
            isSuppressedCalled = true
            return suppressed
        }

        override suspend fun recordInteraction(screenId: String, clientId: String, nowMs: Long) {
            recordCalled = true
        }
    }

    private class FakeSheetPresenter : SheetPresenter {
        var showCount = 0
        var lastConfig: EligibilityConfig? = null

        override fun show(config: EligibilityConfig) {
            showCount++
            lastConfig = config
        }
    }

    private fun buildState(
        scheduler: kotlinx.coroutines.test.TestCoroutineScheduler,
        eligibility: FakeEligibilitySource,
        suppression: FakeSuppressionStore,
        presenter: FakeSheetPresenter,
        session: SessionProvider = FakeSession(),
    ): SignalState {
        val ctx = RuntimeEnvironment.getApplication()
        val scope = CoroutineScope(StandardTestDispatcher(scheduler))
        return SignalState(
            applicationContext = ctx,
            baseUrl = "http://localhost/".toHttpUrl(),
            appKey = "test-app-key",
            sessionProvider = session,
            eligibility = eligibility,
            suppressionCache = suppression,
            sheetPresenter = presenter,
            feedbackClient = com.beatroute.signal.internal.FeedbackClient(
                "http://localhost/".toHttpUrl(), "test-app-key",
            ),
            scope = scope,
            dwellTimer = com.beatroute.signal.internal.DwellTimer(scope) { },
            clock = { fixedNow },
        )
    }

    @After
    fun tearDown() {
        Signal.resetForTest()
    }

    @Test
    fun `locally suppressed short-circuits before any network call`() = runTest {
        val eligibility = FakeEligibilitySource(result = config())
        val suppression = FakeSuppressionStore(suppressed = true)
        val presenter = FakeSheetPresenter()
        Signal.state = buildState(testScheduler, eligibility, suppression, presenter)

        Signal.trackEvent("delivery")
        advanceUntilIdle()

        assertTrue(suppression.isSuppressedCalled)
        assertEquals(0, eligibility.callCount)
        assertEquals(0, presenter.showCount)
    }

    @Test
    fun `not suppressed and eligibility null shows nothing`() = runTest {
        val eligibility = FakeEligibilitySource(result = null)
        val suppression = FakeSuppressionStore(suppressed = false)
        val presenter = FakeSheetPresenter()
        Signal.state = buildState(testScheduler, eligibility, suppression, presenter)

        Signal.trackEvent("delivery")
        advanceUntilIdle()

        assertEquals(1, eligibility.callCount)
        assertEquals(0, presenter.showCount)
        assertFalse(suppression.recordCalled)
    }

    @Test
    fun `not suppressed and eligibility returns config shows sheet once`() = runTest {
        val cfg = config("trig-show")
        val eligibility = FakeEligibilitySource(result = cfg)
        val suppression = FakeSuppressionStore(suppressed = false)
        val presenter = FakeSheetPresenter()
        Signal.state = buildState(testScheduler, eligibility, suppression, presenter)

        Signal.trackEvent("delivery")
        advanceUntilIdle()

        assertEquals(1, presenter.showCount)
        assertEquals(cfg, presenter.lastConfig)
    }

    @Test
    fun `session identity is resolved and passed to eligibility`() = runTest {
        val eligibility = FakeEligibilitySource(result = null)
        val suppression = FakeSuppressionStore(suppressed = false)
        val presenter = FakeSheetPresenter()
        val session = FakeSession(userId = "u-99", clientId = "c-88", repTenure = 123)
        Signal.state = buildState(testScheduler, eligibility, suppression, presenter, session)

        Signal.trackEvent("payment")
        advanceUntilIdle()

        assertEquals("payment", eligibility.lastScreenId)
        assertEquals("u-99", eligibility.lastUserId)
        assertEquals("c-88", eligibility.lastClientId)
        assertTrue(eligibility.repTenureWasSet)
        assertEquals(123, eligibility.lastRepTenure)
    }

    @Test
    fun `exception in flow does not escape and no sheet is shown`() = runTest {
        val eligibility = FakeEligibilitySource(throwError = true)
        val suppression = FakeSuppressionStore(suppressed = false)
        val presenter = FakeSheetPresenter()
        Signal.state = buildState(testScheduler, eligibility, suppression, presenter)

        // Must not throw into the host.
        Signal.trackEvent("delivery")
        advanceUntilIdle()

        assertEquals(1, eligibility.callCount)
        assertEquals(0, presenter.showCount)
        assertNull(presenter.lastConfig)
    }
}
