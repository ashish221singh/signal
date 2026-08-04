package com.beatroute.signal

import com.beatroute.signal.internal.EligibilityResult
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

/**
 * The shared trigger flow (re-keyed to the event model, F2-D3): suppression short-circuit
 * on `(eventName, userId)`, fail-silent eligibility, and presenting the WebView sheet
 * with the raw config result. All collaborators are faked so this stays a pure unit test.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class TrackEventTest {

    private val fixedNow = 1_700_000_000_000L

    private fun result(triggerId: String = "trig-1") =
        EligibilityResult(triggerId = triggerId, rawConfigJson = """{"trigger_id":"$triggerId"}""")

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
        private val result: EligibilityResult? = null,
        private val throwError: Boolean = false,
    ) : EligibilitySource {
        var callCount = 0
        var lastEventName: String? = null
        var lastUserId: String? = null
        var lastContext: String? = null
        var lastSessionAgeDays: Int? = null
        var sessionAgeWasSet = false

        override suspend fun check(
            eventName: String,
            userId: String,
            context: String?,
            sessionAgeDays: Int?,
        ): EligibilityResult? {
            callCount++
            lastEventName = eventName
            lastUserId = userId
            lastContext = context
            lastSessionAgeDays = sessionAgeDays
            sessionAgeWasSet = true
            if (throwError) throw RuntimeException("boom")
            return result
        }
    }

    private class FakeSuppressionStore(
        private val suppressed: Boolean = false,
    ) : SuppressionStore {
        var isSuppressedCalled = false
        var recordCalled = false

        override suspend fun isSuppressed(eventName: String, userId: String, nowMs: Long): Boolean {
            isSuppressedCalled = true
            return suppressed
        }

        override suspend fun recordInteraction(eventName: String, userId: String, nowMs: Long) {
            recordCalled = true
        }
    }

    private class FakeSheetPresenter : SheetPresenter {
        var showCount = 0
        var lastEventName: String? = null
        var lastResult: EligibilityResult? = null

        override fun show(eventName: String, result: EligibilityResult) {
            showCount++
            lastEventName = eventName
            lastResult = result
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
            clock = { fixedNow },
        )
    }

    @After
    fun tearDown() {
        Signal.resetForTest()
    }

    @Test
    fun `locally suppressed short-circuits before any network call`() = runTest {
        val eligibility = FakeEligibilitySource(result = result())
        val suppression = FakeSuppressionStore(suppressed = true)
        val presenter = FakeSheetPresenter()
        Signal.state = buildState(testScheduler, eligibility, suppression, presenter)

        Signal.trackEvent("order_completion")
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

        Signal.trackEvent("order_completion")
        advanceUntilIdle()

        assertEquals(1, eligibility.callCount)
        assertEquals(0, presenter.showCount)
        assertFalse(suppression.recordCalled)
    }

    @Test
    fun `not suppressed and eligibility returns config shows sheet once`() = runTest {
        val res = result("trig-show")
        val eligibility = FakeEligibilitySource(result = res)
        val suppression = FakeSuppressionStore(suppressed = false)
        val presenter = FakeSheetPresenter()
        Signal.state = buildState(testScheduler, eligibility, suppression, presenter)

        Signal.trackEvent("order_completion")
        advanceUntilIdle()

        assertEquals(1, presenter.showCount)
        assertEquals(res, presenter.lastResult)
        assertEquals("order_completion", presenter.lastEventName)
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

        assertEquals("payment", eligibility.lastEventName)
        assertEquals("u-99", eligibility.lastUserId)
        assertNull(eligibility.lastContext)
        assertTrue(eligibility.sessionAgeWasSet)
        assertEquals(123, eligibility.lastSessionAgeDays)
    }

    @Test
    fun `exception in flow does not escape and no sheet is shown`() = runTest {
        val eligibility = FakeEligibilitySource(throwError = true)
        val suppression = FakeSuppressionStore(suppressed = false)
        val presenter = FakeSheetPresenter()
        Signal.state = buildState(testScheduler, eligibility, suppression, presenter)

        // Must not throw into the host.
        Signal.trackEvent("order_completion")
        advanceUntilIdle()

        assertEquals(1, eligibility.callCount)
        assertEquals(0, presenter.showCount)
        assertNull(presenter.lastResult)
    }
}
