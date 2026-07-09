package com.beatroute.signal.internal

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class UploadClientTest {

    private lateinit var server: MockWebServer

    private fun clientUnder(server: MockWebServer): UploadClient =
        UploadClient(baseUrl = server.url("/"), appKey = "test-app-key")

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
    fun `upload presigns then PUTs raw bytes and returns object_url`() = runBlocking {
        val bytes = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
        val objectUrl = "https://cdn.example/feedback/x.jpg"
        val ticketJson = """
            {
              "upload_url": "${server.url("/put-target")}",
              "object_url": "$objectUrl",
              "key": "feedback/x.jpg"
            }
        """.trimIndent()
        // #1 presign 200 with the ticket, #2 the PUT 200.
        server.enqueue(MockResponse().setResponseCode(200).setBody(ticketJson))
        server.enqueue(MockResponse().setResponseCode(200))

        val result = clientUnder(server).upload(bytes, "image/jpeg")

        assertEquals(objectUrl, result)

        val presign = server.takeRequest()
        assertEquals("POST", presign.method)
        assertEquals("/v1/sdk/uploads", presign.path)
        assertEquals("test-app-key", presign.getHeader("X-Signal-App-Key"))
        assertTrue(presign.getHeader("Content-Type")!!.startsWith("application/json"))
        assertTrue(
            "presign body should carry content_type",
            presign.body.readUtf8().contains("\"content_type\":\"image/jpeg\""),
        )

        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("/put-target", put.path)
        assertTrue(
            "PUT content-type should be the image type",
            put.getHeader("Content-Type")!!.startsWith("image/jpeg"),
        )
        assertArrayEquals("PUT body should be the raw input bytes", bytes, put.body.readByteArray())
    }

    @Test
    fun `failed presign returns null and never attempts the PUT`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500))

        val result = clientUnder(server).upload(byteArrayOf(1, 2, 3), "image/jpeg")

        assertNull(result)
        assertEquals("only the presign should have been attempted", 1, server.requestCount)
    }

    @Test
    fun `failed PUT returns null`() = runBlocking {
        val ticketJson = """
            {
              "upload_url": "${server.url("/put-target")}",
              "object_url": "https://cdn.example/feedback/x.jpg",
              "key": "feedback/x.jpg"
            }
        """.trimIndent()
        server.enqueue(MockResponse().setResponseCode(200).setBody(ticketJson))
        server.enqueue(MockResponse().setResponseCode(500))

        val result = clientUnder(server).upload(byteArrayOf(1, 2, 3), "image/jpeg")

        assertNull(result)
        assertEquals(2, server.requestCount)
    }
}
