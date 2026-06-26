package com.pocketsisyphus.android.ui.session

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.pocketsisyphus.android.data.model.AttachmentImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * Decodes + downscales a picked image into an upload-ready JPEG, the same shape as the iPhone
 * (long edge ≤ 1568 px, JPEG q≈0.8). Keeps a small in-memory preview bitmap for the pending chip.
 * Decoding/scaling runs off the main thread; large originals are sampled down during decode so we
 * never hold a full-resolution bitmap in memory.
 */
data class PendingImage(
    val id: String,
    val filename: String,
    val jpeg: ByteArray,
    val preview: ImageBitmap,
) {
    fun toUpload(): AttachmentImage =
        AttachmentImage(
            filename = filename,
            data_b64 = android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP),
        )

    // ByteArray breaks data-class equality/hash — identity is the random id.
    override fun equals(other: Any?): Boolean = other is PendingImage && other.id == id
    override fun hashCode(): Int = id.hashCode()
}

object ImageAttachment {
    private const val MAX_DIM = 1568
    private const val JPEG_QUALITY = 80

    suspend fun prepare(resolver: ContentResolver, uri: Uri): PendingImage? =
        withContext(Dispatchers.IO) {
            runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null

                // Sample down during decode so the held bitmap stays near the target size.
                var sample = 1
                val longest = maxOf(bounds.outWidth, bounds.outHeight)
                while (longest / (sample * 2) >= MAX_DIM) sample *= 2
                val opts = BitmapFactory.Options().apply { inSampleSize = sample }
                val decoded = resolver.openInputStream(uri)?.use {
                    BitmapFactory.decodeStream(it, null, opts)
                } ?: return@runCatching null

                val oriented = applyExifOrientation(resolver, uri, decoded)
                val scaled = scaleToMax(oriented, MAX_DIM)
                val jpeg = ByteArrayOutputStream().use { out ->
                    scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                    out.toByteArray()
                }
                if (jpeg.isEmpty()) return@runCatching null
                val short = UUID.randomUUID().toString().take(8).lowercase()
                PendingImage(
                    id = UUID.randomUUID().toString(),
                    filename = "img-$short.jpg",
                    jpeg = jpeg,
                    preview = scaled.asImageBitmap(),
                )
            }.getOrNull()
        }

    private fun scaleToMax(src: Bitmap, maxDim: Int): Bitmap {
        val longest = maxOf(src.width, src.height)
        if (longest <= maxDim) return src
        val ratio = maxDim.toFloat() / longest
        val w = (src.width * ratio).toInt().coerceAtLeast(1)
        val h = (src.height * ratio).toInt().coerceAtLeast(1)
        val scaled = Bitmap.createScaledBitmap(src, w, h, true)
        if (scaled !== src) src.recycle()
        return scaled
    }

    private fun applyExifOrientation(resolver: ContentResolver, uri: Uri, src: Bitmap): Bitmap {
        val orientation = runCatching {
            resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
            ) }
        }.getOrNull() ?: ExifInterface.ORIENTATION_NORMAL
        if (orientation == ExifInterface.ORIENTATION_NORMAL ||
            orientation == ExifInterface.ORIENTATION_UNDEFINED
        ) {
            return src
        }
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            else -> return src
        }
        val rotated = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
        if (rotated !== src) src.recycle()
        return rotated
    }
}
