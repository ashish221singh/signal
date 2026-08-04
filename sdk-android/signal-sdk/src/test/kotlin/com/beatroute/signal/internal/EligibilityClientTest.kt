package com.beatroute.signal.internal

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Re-keyed to the event model (F2-D3/D13): the request carries
 * `{ event_name, user_id, context?, session_age_days? }` and the response is kept as
 * the RAW config JSON (native never parses the full config, GR-2) — only `trigger_id`
 * is extracted for outbox idempotency + forwarding.
 */
@RunWith(RobolectricTestRunner::class)
class EligibilityClientTest {

    private lateinit var server: MockWebServer

    private fun fixture(name: String): String =
        EligibilityClientTest::class.java.getResourceAsStream("/fixtures/$name")!!
            .bufferedReader().readText()

    private fun clientUnder(server: MockWebServer, okHttp: OkHttpClient? = null): EligibilityClient =
        if (okHttp == null) {
            EligibilityClient(baseUrl = server.url("/"), appKey = "test-app-key")
        } else {
            EligibilityClient(baseUrl = server.url("/"), appKey = "test-app-key", client = okHttp)
        }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `200 with config body returns result carrying trigger_id and raw json`() = runBlocking {
        val body = fixture("eligibility_config.json")
        server.enqueue(MockResponse().setResponseCode(200).setBody(body))

        val result = clientUnder(server).check(
            eventName = "order_completion", userId = "u1", context = null, sessionAgeDays = 30,
        )

        assertNotNull(result)
        assertEquals("11111111-1111-4111-8111-111111111111", result!!.triggerId)
        // The raw config is forwarded verbatim to web-core (still parses to the fixture).
        assertEquals(body, result.rawConfigJson)
    }

    @Test
    fun `204 returns null`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        val result = clientUnder(server).check(
            eventName = "order_completion", userId = "u1", context = null, sessionAgeDays = 30,
        )

        assertNull(result)
    }

    @Test
    fun `500 returns null without throwing`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500).setBody(fixture("error_body.json")))

        val result = clientUnder(server).check(
            eventName = "order_completion", userId = "u1", context = null, sessionAgeDays = 30,
        )

        assertNull(result)
    }

    @Test
    fun `slow response exceeding call timeout returns null without throwing`() = runBlocking {
        // Body delayed ~3s while the client call timeout is 2s -> timeout -> null.
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody(fixture("eligibility_config.json"))
                .setBodyDelay(3, TimeUnit.SECONDS),
        )
        val fastTimeout = OkHttpClient.Builder().callTimeout(2, TimeUnit.SECONDS).build()

        val result = clientUnder(server, fastTimeout).check(
            eventName = "order_completion", userId = "u1", context = null, sessionAgeDays = 30,
        )

        assertNull(result)
    }

    @Test
    fun `malformed json on 200 returns null`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{ this is not json"))

        val result = clientUnder(server).check(
            eventName = "order_completion", userId = "u1", context = null, sessionAgeDays = 30,
        )

        assertNull(result)
    }

    @Test
    fun `request carries app key header and re-keyed query params`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        clientUnder(server).check(
            eventName = "order_completion", userId = "u1", context = "checkout", sessionAgeDays = 30,
        )

        val request = server.takeRequest()
        assertEquals("test-app-key", request.getHeader("X-Signal-App-Key"))
        val url = request.requestUrl!!
        assertEquals("order_completion", url.queryParameter("event_name"))
        assertEquals("u1", url.queryParameter("user_id"))
        assertEquals("checkout", url.queryParameter("context"))
        assertEquals("30", url.queryParameter("session_age_days"))
        // Old screen-model params are gone.
        assertNull(url.queryParameter("screen_id"))
        assertNull(url.queryParameter("client_id"))
        assertNull(url.queryParameter("rep_tenure_days"))
    }

    @Test
    fun `optional context and session_age_days omitted when null`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        clientUnder(server).check(
            eventName = "order_completion", userId = "u1", context = null, sessionAgeDays = null,
        )

        val request = server.takeRequest()
        val url = request.requestUrl!!
        assertEquals("order_completion", url.queryParameter("event_name"))
        assertNull(url.queryParameter("context"))
        assertNull(url.queryParameter("session_age_days"))
        assertEquals(false, url.queryParameterNames.contains("session_age_days"))
    }
}
