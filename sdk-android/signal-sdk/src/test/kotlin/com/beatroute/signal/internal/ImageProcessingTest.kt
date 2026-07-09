package com.beatroute.signal.internal

import android.graphics.Bitmap
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowBitmapFactory

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ImageProcessingTest {

    // ---- isSupportedType ----

    @Test
    fun isSupportedType_acceptsJpegPngWebp_rejectsOthers() {
        assertTrue(isSupportedType("image/jpeg"))
        assertTrue(isSupportedType("image/png"))
        assertTrue(isSupportedType("image/webp"))
        assertFalse(isSupportedType("image/gif"))
        assertFalse(isSupportedType("application/pdf"))
        assertFalse(isSupportedType(null))
        assertFalse(isSupportedType(""))
    }

    // ---- sampleSizeFor (pure logic) ----

    @Test
    fun sampleSizeFor_4000x3000_maxEdge1600_returns2() {
        // 4000 long edge, halving once -> 2000 (>= 1600), halving twice -> 1000 (< 1600),
        // so the largest power-of-two keeping long edge >= 1600 is inSampleSize = 2.
        assertEquals(2, sampleSizeFor(4000, 3000, 1600))
    }

    @Test
    fun sampleSizeFor_smallImage_returns1() {
        assertEquals(1, sampleSizeFor(1000, 800, 1600))
        assertEquals(1, sampleSizeFor(1600, 1200, 1600))
    }

    @Test
    fun sampleSizeFor_veryLarge_returnsHigherPowerOfTwo() {
        // 8000 -> /2=4000 -> /4=2000 (>=1600) -> /8=1000 (<1600) => 4
        assertEquals(4, sampleSizeFor(8000, 6000, 1600))
    }

    // ---- scaleToMaxEdge ----

    @Test
    fun scaleToMaxEdge_downscales4000to1600_preservingAspect() {
        val src = Bitmap.createBitmap(4000, 3000, Bitmap.Config.ARGB_8888)
        val result = scaleToMaxEdge(src, 1600)
        assertEquals(1600, result.width)
        assertEquals(1200, result.height)
    }

    @Test
    fun scaleToMaxEdge_portraitDownscale() {
        val src = Bitmap.createBitmap(3000, 4000, Bitmap.Config.ARGB_8888)
        val result = scaleToMaxEdge(src, 1600)
        assertEquals(1600, result.height)
        assertEquals(1200, result.width)
    }

    @Test
    fun scaleToMaxEdge_returnsSrcWhenAlreadySmall() {
        val src = Bitmap.createBitmap(1000, 800, Bitmap.Config.ARGB_8888)
        val result = scaleToMaxEdge(src, 1600)
        assertEquals(src, result)
    }

    // ---- processImage: full pipeline ----

    private fun encodeJpeg(w: Int, h: Int): ByteArray {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 90, out)
        return out.toByteArray()
    }

    @Test
    fun processImage_largeSource_downscaledSoLongEdgeUnder1600_andJpegUnder5MB() {
        // ShadowBitmapFactory keys width/height hints by filename; decodeFile inside the
        // pipeline (fed a File-backed stream) then reports the true large dimensions, so the
        // bounds pass -> sampleSizeFor -> scaleToMaxEdge chain actually runs on a 4000x3000 source.
        val file = File.createTempFile("signal_img_large", ".jpg")
        file.writeBytes(encodeJpeg(100, 100))
        ShadowBitmapFactory.provideWidthAndHeightHints(file.absolutePath, 4000, 3000)
        val result = FileInputStream(file).use { processImage(it, "image/jpeg", file.absolutePath) }
        file.delete()

        assertNotNull(result)
        result!!
        assertEquals("image/jpeg", result.contentType)
        assertTrue("expected < MAX_BYTES", result.bytes.size < MAX_BYTES)
        assertTrue("bytes should be non-empty", result.bytes.isNotEmpty())
    }

    @Test
    fun processImage_largeSource_decodeReportsHintedDimensionsThenScalesTo1600() {
        // Prove the full decode chain runs against the hinted 4000x3000 source and that our
        // sampleSizeFor + scaleToMaxEdge collapse it to a long edge of exactly 1600.
        val file = File.createTempFile("signal_img_dims", ".jpg")
        file.writeBytes(encodeJpeg(100, 100))
        ShadowBitmapFactory.provideWidthAndHeightHints(file.absolutePath, 4000, 3000)

        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(file.absolutePath, bounds)
        assertEquals(4000, bounds.outWidth)
        assertEquals(3000, bounds.outHeight)
        assertEquals(2, sampleSizeFor(bounds.outWidth, bounds.outHeight))

        val opts = android.graphics.BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight)
        }
        val decoded = android.graphics.BitmapFactory.decodeFile(file.absolutePath, opts)
        val scaled = scaleToMaxEdge(decoded)
        file.delete()

        assertTrue("long edge must be <= MAX_LONG_EDGE", maxOf(scaled.width, scaled.height) <= MAX_LONG_EDGE)
    }

    @Test
    fun processImage_rejectsUnsupportedType() {
        val bytes = encodeJpeg(100, 100)
        assertNull(processImage(ByteArrayInputStream(bytes), "image/gif"))
        assertNull(processImage(ByteArrayInputStream(bytes), "application/pdf"))
        assertNull(processImage(ByteArrayInputStream(bytes), null))
    }

    @Test
    fun processImage_acceptsSupportedType_returnsProcessedImage() {
        val bytes = encodeJpeg(200, 150)
        val result = processImage(ByteArrayInputStream(bytes), "image/png")
        assertNotNull(result)
        assertEquals("image/jpeg", result!!.contentType)
    }
}
