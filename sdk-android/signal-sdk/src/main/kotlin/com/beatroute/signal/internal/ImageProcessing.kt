package com.beatroute.signal.internal

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream

/**
 * Client-side image guardrails (M3-D14).
 *
 * Every accepted image is downscaled so its long edge is <= [MAX_LONG_EDGE] and re-encoded
 * to JPEG. The re-encoded payload must be <= [MAX_BYTES]; this protects the rep's data plan
 * and the storage bucket. Only jpeg/png/webp inputs are accepted; output is always JPEG.
 */

const val MAX_LONG_EDGE = 1600
const val MAX_BYTES = 5 * 1024 * 1024
const val JPEG_QUALITY = 85

/** Lower quality used for a single re-encode retry if the first pass exceeds [MAX_BYTES]. */
private const val JPEG_QUALITY_RETRY = 70

val SUPPORTED_TYPES = setOf("image/jpeg", "image/png", "image/webp")

internal data class ProcessedImage(val bytes: ByteArray, val contentType: String) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ProcessedImage) return false
        return contentType == other.contentType && bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int = 31 * bytes.contentHashCode() + contentType.hashCode()
}

/** True only for the three supported input MIME types. */
internal fun isSupportedType(contentType: String?): Boolean =
    contentType != null && contentType in SUPPORTED_TYPES

/**
 * Power-of-two [BitmapFactory.Options.inSampleSize] such that the decoded bitmap's long edge is
 * >= [maxEdge] but not wastefully larger. Standard Android downsampling pattern: keep halving
 * while the halved long edge still stays >= [maxEdge]. Pure and directly testable.
 */
internal fun sampleSizeFor(width: Int, height: Int, maxEdge: Int = MAX_LONG_EDGE): Int {
    val longEdge = maxOf(width, height)
    var sampleSize = 1
    while (longEdge / (sampleSize * 2) >= maxEdge) {
        sampleSize *= 2
    }
    return sampleSize
}

/**
 * If the long edge is already <= [maxEdge] the source is returned unchanged; otherwise the
 * bitmap is scaled with the aspect ratio preserved so its long edge == [maxEdge].
 */
internal fun scaleToMaxEdge(src: Bitmap, maxEdge: Int = MAX_LONG_EDGE): Bitmap {
    val longEdge = maxOf(src.width, src.height)
    if (longEdge <= maxEdge) return src
    val scale = maxEdge.toFloat() / longEdge.toFloat()
    val targetW = (src.width * scale).toInt().coerceAtLeast(1)
    val targetH = (src.height * scale).toInt().coerceAtLeast(1)
    return Bitmap.createScaledBitmap(src, targetW, targetH, true)
}

/**
 * Full pipeline over a [Uri] resolved from [context]. Reads the stream twice (bounds pass, then
 * a full decode) via the content resolver. Returns null on any I/O failure or guardrail rejection.
 */
internal fun processImage(context: Context, uri: Uri, declaredType: String?): ProcessedImage? {
    if (!isSupportedType(declaredType)) return null
    val bytes = try {
        context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    } catch (_: Exception) {
        null
    } ?: return null
    return processImage(ByteArrayInputStream(bytes), declaredType, uri.toString())
}

/**
 * Full pipeline over an already-read [InputStream]. Rejects unsupported [declaredType] up front,
 * decodes bounds, downsamples with [sampleSizeFor], scales to [MAX_LONG_EDGE], then re-encodes to
 * JPEG at [JPEG_QUALITY].
 *
 * Size-cap handling: if the first JPEG pass exceeds [MAX_BYTES] we retry ONCE at a lower quality
 * ([JPEG_QUALITY_RETRY]). If it still exceeds the cap we return null rather than upload an
 * oversized payload — the caller surfaces this as a rejection to the rep.
 */
internal fun processImage(
    input: InputStream,
    declaredType: String?,
    decodeName: String? = null,
): ProcessedImage? {
    if (!isSupportedType(declaredType)) return null

    // Buffer once so we can perform the two-pass decode from the same bytes.
    val raw = try {
        input.readBytes()
    } catch (_: Exception) {
        return null
    }
    if (raw.isEmpty()) return null

    // When [decodeName] names a real file we decode via decodeFile (lets the caller decode a
    // file path directly and also lets tests supply dimension hints keyed by filename); otherwise
    // we decode from the buffered bytes.
    val fileName = decodeName?.takeIf { File(it).isFile }

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    if (fileName != null) {
        BitmapFactory.decodeFile(fileName, bounds)
    } else {
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
    }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    val decodeOpts = BitmapFactory.Options().apply {
        inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight)
    }
    val decoded = if (fileName != null) {
        BitmapFactory.decodeFile(fileName, decodeOpts)
    } else {
        BitmapFactory.decodeByteArray(raw, 0, raw.size, decodeOpts)
    } ?: return null
    val scaled = scaleToMaxEdge(decoded)

    encodeJpeg(scaled, JPEG_QUALITY)?.let { first ->
        if (first.size <= MAX_BYTES) return ProcessedImage(first, "image/jpeg")
    }
    encodeJpeg(scaled, JPEG_QUALITY_RETRY)?.let { retry ->
        if (retry.size <= MAX_BYTES) return ProcessedImage(retry, "image/jpeg")
    }
    return null
}

private fun encodeJpeg(bitmap: Bitmap, quality: Int): ByteArray? =
    try {
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
        out.toByteArray()
    } catch (_: Exception) {
        null
    }
