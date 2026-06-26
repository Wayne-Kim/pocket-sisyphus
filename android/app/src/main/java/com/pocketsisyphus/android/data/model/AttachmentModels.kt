package com.pocketsisyphus.android.data.model

import kotlinx.serialization.Serializable

/**
 * Image attachment upload — same daemon contract as the iPhone (`POST /:id/attachments`). Base64
 * images are stored in the session repo's `dir` (default `attachments`) and the returned
 * repo-relative paths are referenced in the next prompt so the agent can Read them.
 */
@Serializable
data class AttachmentImage(
    val filename: String,
    val data_b64: String,
)

@Serializable
data class AttachmentUploadRequest(
    val dir: String? = null,
    val images: List<AttachmentImage>,
)

@Serializable
data class AttachmentUploadResponse(
    val saved: List<SavedAttachment> = emptyList(),
)

/** One stored attachment row. `rel` is the repo-relative path referenced from the prompt. */
@Serializable
data class SavedAttachment(
    val rel: String,
    val abs: String = "",
    val bytes: Int = 0,
)
