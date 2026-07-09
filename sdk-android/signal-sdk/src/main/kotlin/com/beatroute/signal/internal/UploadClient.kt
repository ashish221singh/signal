package com.beatroute.signal.internal

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The pre-signed upload ticket returned by `POST /v1/sdk/uploads` (M3-D2). The image bytes
 * are PUT directly to [uploadUrl]; once that succeeds the image lives at [objectUrl], and
 * only [objectUrl] is ever carried inside `/response` — the bytes never travel through it.
 */
@Serializable
internal data class UploadTicket(
    @SerialName("upload_url") val uploadUrl: String,
    @SerialName("object_url") val objectUrl: String,
    val key: String,
)

/**
 * Seam so the bottom sheet can be handed an uploader without depending on the concrete
 * [UploadClient] (and so tests / the G.3 presenter can substitute a fake).
 */
internal interface ImageUploader {
    suspend fun upload(bytes: ByteArray, contentType: String): String?
}

/**
 * Two-step pre-signed upload (M3-D2 / Task F.2).
 *
 * 1. `POST /v1/sdk/uploads` (behind `X-Signal-App-Key`) with `{"content_type": <type>}` to
 *    obtain an [UploadTicket].
 * 2. `PUT` the raw bytes to [UploadTicket.uploadUrl] with the image `Content-Type`.
 *
 * The image is OPTIONAL: any failure (non-200 presign, parse error, failed PUT, IO/timeout)
 * yields `null` so the caller submits feedback without an attachment rather than blocking it.
 */
internal class UploadClient(
    private val baseUrl: HttpUrl,
    private val appKey: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS).build(),
) : ImageUploader {

    override suspend fun upload(bytes: ByteArray, contentType: String): String? =
        withContext(Dispatchers.IO) {
            try {
                val ticket = presign(contentType) ?: return@withContext null
                if (!put(ticket.uploadUrl, bytes, contentType)) return@withContext null
                ticket.objectUrl
            } catch (_: IOException) {
                // Transport failure (connect refused, timeout, reset) — image is optional.
                null
            }
        }

    /** Step 1: obtain a pre-signed ticket, or null on a non-200 / unparseable response. */
    private fun presign(contentType: String): UploadTicket? {
        val url = baseUrl.newBuilder().addPathSegments("v1/sdk/uploads").build()
        val json = buildJsonObject { put("content_type", contentType) }.toString()
        val req = Request.Builder()
            .url(url)
            .header("X-Signal-App-Key", appKey)
            .post(json.toRequestBody("application/json".toMediaType()))
            .build()
        return client.newCall(req).execute().use { res ->
            if (res.code != 200) return null
            val body = res.body?.string() ?: return null
            runCatching { SignalJson.decodeFromString<UploadTicket>(body) }.getOrNull()
        }
    }

    /** Step 2: PUT the raw bytes to the pre-signed URL. Returns true only on a 2xx. */
    private fun put(uploadUrl: String, bytes: ByteArray, contentType: String): Boolean {
        val req = Request.Builder()
            .url(uploadUrl)
            .put(bytes.toRequestBody(contentType.toMediaType()))
            .build()
        return client.newCall(req).execute().use { res -> res.isSuccessful }
    }
}
