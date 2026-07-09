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
    fun `200 with config body returns non-null config matching fixture`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("eligibility_config.json")))

        val result = clientUnder(server).check(
            screenId = "delivery", userId = "u1", clientId = "c1", repTenureDays = 30,
        )

        assertNotNull(result)
        assertEquals("11111111-1111-4111-8111-111111111111", result!!.triggerId)
    }

    @Test
    fun `204 returns null`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        val result = clientUnder(server).check(
            screenId = "delivery", userId = "u1", clientId = "c1", repTenureDays = 30,
        )

        assertNull(result)
    }

    @Test
    fun `500 returns null without throwing`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500).setBody(fixture("error_body.json")))

        val result = clientUnder(server).check(
            screenId = "delivery", userId = "u1", clientId = "c1", repTenureDays = 30,
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
            screenId = "delivery", userId = "u1", clientId = "c1", repTenureDays = 30,
        )

        assertNull(result)
    }

    @Test
    fun `malformed json on 200 returns null`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{ this is not json"))

        val result = clientUnder(server).check(
            screenId = "delivery", userId = "u1", clientId = "c1", repTenureDays = 30,
        )

        assertNull(result)
    }

    @Test
    fun `request carries app key header and query params`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        clientUnder(server).check(
            screenId = "delivery", userId = "u1", clientId = "c1", repTenureDays = 30,
        )

        val request = server.takeRequest()
        assertEquals("test-app-key", request.getHeader("X-Signal-App-Key"))
        val url = request.requestUrl!!
        assertEquals("delivery", url.queryParameter("screen_id"))
        assertEquals("u1", url.queryParameter("user_id"))
        assertEquals("c1", url.queryParameter("client_id"))
        assertEquals("30", url.queryParameter("rep_tenure_days"))
    }

    @Test
    fun `rep_tenure_days omitted when null`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        clientUnder(server).check(
            screenId = "delivery", userId = "u1", clientId = "c1", repTenureDays = null,
        )

        val request = server.takeRequest()
        val url = request.requestUrl!!
        assertEquals("delivery", url.queryParameter("screen_id"))
        assertNull(url.queryParameter("rep_tenure_days"))
        assertEquals(false, url.queryParameterNames.contains("rep_tenure_days"))
    }
}
