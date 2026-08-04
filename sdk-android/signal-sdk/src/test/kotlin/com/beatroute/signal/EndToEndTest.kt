package com.beatroute.signal

import android.app.Application
import android.os.Bundle
import android.os.Looper.getMainLooper
import androidx.appcompat.app.AppCompatActivity
import androidx.test.core.app.ApplicationProvider
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import com.beatroute.signal.internal.ResponseBody
import com.beatroute.signal.internal.SignalJson
import com.beatroute.signal.internal.outbox.OutboxDependencies
import com.beatroute.signal.internal.outbox.OutboxEntity
import com.beatroute.signal.internal.outbox.OutboxWorker
import com.beatroute.signal.ui.WebViewSheetFragment
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * F2 refit exit proof: the WHOLE Signal loop against a real [MockWebServer], driven
 * through the REAL `Signal.init` wiring — a real
 * [com.beatroute.signal.internal.EligibilityClient] (re-keyed to `event_name`), the
 * real [com.beatroute.signal.internal.WebSheetPresenter] (shows the real
 * [WebViewSheetFragment] hosting the bundled web-core via the
 * [com.beatroute.signal.internal.ActivityTracker] registered on the Application), the
 * real per-sheet [com.beatroute.signal.internal.SignalBridge], the real Room outbox,
 * the real [com.beatroute.signal.internal.LocalSuppressionCache] (DataStore), and the
 * real [OutboxWorker]. Nothing is faked except the host [SessionProvider] and the
 * network peer (the mock server).
 *
 * trackEvent -> eligibility GET (event_name) -> WebView sheet shown (bundled web-core)
 * -> bridge SUBMIT -> outbox row -> worker flush -> POST /response -> row cleared ->
 * a second trackEvent is short-circuited by local suppression (no second GET).
 *
 * DRIVING SUBMIT under Robolectric: a real WebView cannot execute the bundled web-core
 * JS in a JVM unit test, so — exactly as the pre-refit test drove the presenter's
 * onSubmit bridge — we drive the shown fragment's installed [SignalBridge] directly with
 * the exact SUBMIT JSON web-core emits. That bridge IS the real submit path: the
 * presenter installs it in `show(...)`, so calling it exercises the real
 * bridge -> outbox -> suppression path end to end. Everything else (init wiring,
 * eligibility HTTP, fragment show, worker flush, POST HTTP, suppression short-circuit)
 * runs through the genuine production code. The visual sheet render is covered by the
 * web-core JS suite.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class EndToEndTest {

    /** A Material3/AppCompat-themed host so the DialogFragment can attach. */
    class HostActivity : AppCompatActivity() {
        override fun onCreate(savedInstanceState: Bundle?) {
            setTheme(com.beatroute.signal.R.style.Theme_Signal)
            super.onCreate(savedInstanceState)
        }
    }

    /** The fixture's trigger_id — the config that eligibility hands back. */
    private val fixtureTriggerId = "11111111-1111-4111-8111-111111111111"

    private lateinit var server: MockWebServer
    private lateinit var app: Application
    private lateinit var activity: HostActivity

    /** Counts eligibility GETs seen by the mock, so step 5 can prove no second call. */
    private val eligibilityGets = AtomicInteger(0)

    /** Host-owned identity; the only real collaborator we substitute. */
    private class FakeSession : SessionProvider {
        override fun userId(): String = "user-42"
        override fun clientId(): String = "client-7"
        override fun repTenureDays(): Int? = 90
    }

    private fun fixture(name: String): String =
        EndToEndTest::class.java.getResourceAsStream("/fixtures/$name")!!
            .bufferedReader().readText()

    @After
    fun tearDown() {
        Signal.resetForTest()
        server.shutdown()
        OutboxDependencies.dao = null
        OutboxDependencies.feedback = null
    }

    private fun awaitTrue(condition: () -> Boolean): Boolean {
        repeat(50) {
            shadowOf(getMainLooper()).idle()
            if (condition()) return true
            Thread.sleep(10)
        }
        shadowOf(getMainLooper()).idle()
        return condition()
    }

    private fun pending(): List<OutboxEntity> =
        runBlocking { OutboxDependencies.dao!!.pending() }

    @Test
    fun `full loop trackEvent to web sheet to bridge submit to outbox flush, then suppressed`() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    request.method == "GET" && path.startsWith("/v1/sdk/eligibility") -> {
                        eligibilityGets.incrementAndGet()
                        MockResponse().setResponseCode(200)
                            .setBody(fixture("eligibility_config.json"))
                    }
                    request.method == "POST" && path.startsWith("/v1/sdk/response") ->
                        MockResponse().setResponseCode(204)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()

        app = ApplicationProvider.getApplicationContext()

        // Ordering: init FIRST so the ActivityTracker registers on the Application,
        // THEN resume the host so the tracker captures the resumed FragmentActivity.
        Signal.init(
            context = app,
            environment = SignalEnvironment.STAGING,
            sessionProvider = FakeSession(),
            baseUrlOverride = server.url("/").toString(),
            appKeyOverride = "e2e-key",
        )
        WorkManagerTestInitHelper.initializeTestWorkManager(app)

        activity = Robolectric.buildActivity(HostActivity::class.java).setup().get()

        // ---- Step 1: trackEvent -> real eligibility GET (re-keyed to event_name) ----
        Signal.trackEvent("order_completion")

        assertTrue(
            "expected an eligibility GET after trackEvent",
            awaitTrue { eligibilityGets.get() >= 1 },
        )
        val eligibilityReq = server.takeRequest(2, TimeUnit.SECONDS)!!
        assertEquals("GET", eligibilityReq.method)
        assertTrue(eligibilityReq.path!!.startsWith("/v1/sdk/eligibility"))
        assertEquals("e2e-key", eligibilityReq.getHeader("X-Signal-App-Key"))
        val eligibilityUrl = eligibilityReq.requestUrl!!
        assertEquals("order_completion", eligibilityUrl.queryParameter("event_name"))
        assertEquals("user-42", eligibilityUrl.queryParameter("user_id"))
        assertEquals("90", eligibilityUrl.queryParameter("session_age_days"))
        // Old screen-model params are gone.
        assertNull(eligibilityUrl.queryParameter("screen_id"))
        assertNull(eligibilityUrl.queryParameter("client_id"))

        // ---- Step 2: the WebView sheet fragment is shown on the host ----
        assertTrue(
            "expected the signal_web_sheet fragment to be shown",
            awaitTrue {
                activity.supportFragmentManager
                    .findFragmentByTag(WebViewSheetFragment.SHEET_TAG) != null
            },
        )
        val fragment = activity.supportFragmentManager
            .findFragmentByTag(WebViewSheetFragment.SHEET_TAG) as? WebViewSheetFragment
        assertNotNull("shown fragment should be a WebViewSheetFragment", fragment)
        val bridge = fragment!!.bridge
        assertNotNull("the presenter wired a SignalBridge into the fragment", bridge)

        // ---- Step 3: drive a SUBMIT through the installed bridge (see class doc) ----
        // rating_value 3 on the emoji scale (positive_threshold 3) -> positive.
        bridge!!.submit(
            """
            {
              "bridge_version": 1,
              "answer": { "trigger_id": "$fixtureTriggerId", "rating_value": 3, "positive": true }
            }
            """.trimIndent(),
        )

        assertTrue(
            "expected exactly one response row in the outbox after submit",
            awaitTrue { pending().size == 1 },
        )
        val rows = pending()
        assertEquals(1, rows.size)
        assertEquals("response", rows[0].kind)
        assertEquals(fixtureTriggerId, rows[0].triggerId)
        val enqueued = SignalJson.decodeFromString<ResponseBody>(rows[0].payloadJson)
        assertEquals(fixtureTriggerId, enqueued.triggerId)
        assertEquals(3, enqueued.ratingValue)
        // The bridge patched session_age_days from the SessionProvider.
        assertEquals(90, enqueued.sessionAgeDays)

        // ---- Step 4: run the real worker -> POST /response -> row cleared ----
        val worker = TestListenableWorkerBuilder<OutboxWorker>(app).build()
        val result = runBlocking { worker.doWork() }
        assertEquals(ListenableWorker.Result.success(), result)

        val responseReq = server.takeRequest(2, TimeUnit.SECONDS)!!
        assertEquals("POST", responseReq.method)
        assertTrue(responseReq.path!!.startsWith("/v1/sdk/response"))
        assertEquals("e2e-key", responseReq.getHeader("X-Signal-App-Key"))
        val postedBody = SignalJson.decodeFromString<ResponseBody>(responseReq.body.readUtf8())
        assertEquals(fixtureTriggerId, postedBody.triggerId)
        assertEquals(3, postedBody.ratingValue)

        assertTrue(
            "outbox should be empty after a successful flush",
            awaitTrue { pending().isEmpty() },
        )

        // ---- Step 5: a second trackEvent is short-circuited by local suppression ----
        val realCache = Signal.state!!.suppressionCache
        assertTrue(
            "the submit should have recorded local suppression for the pair",
            awaitTrue {
                runBlocking {
                    realCache.isSuppressed("order_completion", "user-42", System.currentTimeMillis())
                }
            },
        )

        val getsBeforeSecond = eligibilityGets.get()
        Signal.trackEvent("order_completion")
        repeat(20) {
            shadowOf(getMainLooper()).idle()
            Thread.sleep(10)
        }
        assertEquals(
            "suppression must short-circuit eligibility on the second trackEvent",
            getsBeforeSecond,
            eligibilityGets.get(),
        )
        assertNull(server.takeRequest(500, TimeUnit.MILLISECONDS))
    }
}
