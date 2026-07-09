package com.beatroute.signal.internal

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FeedbackClientTest {

    private lateinit var server: MockWebServer

    private fun clientUnder(server: MockWebServer): FeedbackClient =
        FeedbackClient(baseUrl = server.url("/"), appKey = "test-app-key")

    private fun responseBody(triggerId: String = "resp-trigger-1"): ResponseBody =
        ResponseBody(
            triggerId = triggerId,
            ratingValue = 5,
            deviceOs = "android-34",
            appVersion = "1.2.3",
            shownAt = "2026-07-09T10:00:00Z",
            respondedAt = "2026-07-09T10:00:05Z",
        )

    private fun dismissBody(triggerId: String = "dismiss-trigger-1"): DismissBody =
        DismissBody(
            triggerId = triggerId,
            shownAt = "2026-07-09T10:00:00Z",
            dismissedAt = "2026-07-09T10:00:05Z",
        )

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
    fun `postResponse 204 returns Success`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        val result = clientUnder(server).postResponse(responseBody())

        assertEquals(SendResult.Success, result)
    }

    @Test
    fun `postDismiss 204 returns Success`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        val result = clientUnder(server).postDismiss(dismissBody())

        assertEquals(SendResult.Success, result)
    }

    @Test
    fun `postResponse 500 returns RetryableFailure`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500))

        val result = clientUnder(server).postResponse(responseBody())

        assertEquals(SendResult.RetryableFailure, result)
    }

    @Test
    fun `postDismiss 500 returns RetryableFailure`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500))

        val result = clientUnder(server).postDismiss(dismissBody())

        assertEquals(SendResult.RetryableFailure, result)
    }

    @Test
    fun `connection failure returns RetryableFailure`() = runBlocking {
        // Deterministic transport failure: shut the server down before the call so the
        // socket connect fails immediately with an IOException.
        server.shutdown()

        val result = clientUnder(server).postResponse(responseBody())

        assertEquals(SendResult.RetryableFailure, result)
    }

    @Test
    fun `postResponse 404 returns Drop`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404))

        val result = clientUnder(server).postResponse(responseBody())

        assertEquals(SendResult.Drop, result)
    }

    @Test
    fun `postResponse 422 returns Drop`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(422))

        val result = clientUnder(server).postResponse(responseBody())

        assertEquals(SendResult.Drop, result)
    }

    @Test
    fun `postDismiss 404 returns Drop`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404))

        val result = clientUnder(server).postDismiss(dismissBody())

        assertEquals(SendResult.Drop, result)
    }

    @Test
    fun `postResponse sends app key header, json content type, and serialized body`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        clientUnder(server).postResponse(responseBody(triggerId = "trig-abc"))

        val request = server.takeRequest()
        assertEquals("/v1/sdk/response", request.path)
        assertEquals("test-app-key", request.getHeader("X-Signal-App-Key"))
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        val decoded = SignalJson.decodeFromString<ResponseBody>(request.body.readUtf8())
        assertEquals("trig-abc", decoded.triggerId)
    }

    @Test
    fun `postDismiss sends app key header, json content type, and serialized body`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        clientUnder(server).postDismiss(dismissBody(triggerId = "trig-xyz"))

        val request = server.takeRequest()
        assertEquals("/v1/sdk/dismiss", request.path)
        assertEquals("test-app-key", request.getHeader("X-Signal-App-Key"))
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        val decoded = SignalJson.decodeFromString<DismissBody>(request.body.readUtf8())
        assertEquals("trig-xyz", decoded.triggerId)
    }
}
