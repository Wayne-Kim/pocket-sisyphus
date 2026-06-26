package com.pocketsisyphus.android.data

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * Per-app language override, applied without AppCompat.
 *
 * The selected BCP-47 tag is persisted in plain SharedPreferences (a language choice is not a
 * secret) and re-applied in [MainActivity.attachBaseContext] on every activity creation — so it
 * survives rotation, re-entry, and process death. Changing it calls `Activity.recreate()`, which
 * re-runs `attachBaseContext` and reloads every catalog in the new locale immediately.
 *
 * `null`/empty tag = follow the system language (no override). Tags map 1:1 to the bundled
 * `values-*` resource folders (e.g. `zh-Hans`, `pt-BR`), matching the iOS `knownRegions` set.
 */
object LocalePrefs {
    private const val FILE = "ps_locale_prefs"
    private const val KEY_TAG = "app_language_tag"

    /** Languages the app ships, in display order. `tag` is empty for «follow system». */
    val languages: List<Pair<String, String>> = listOf(
        "ko" to "한국어",
        "en" to "English",
        "zh-Hans" to "简体中文",
        "ja" to "日本語",
        "es" to "Español",
        "fr" to "Français",
        "hi" to "हिन्दी",
        "ar" to "العربية",
        "pt-BR" to "Português (Brasil)",
        "ru" to "Русский",
    )

    /** The persisted override tag, or null when following the system language. */
    fun currentTag(context: Context): String? =
        context.applicationContext
            .getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .getString(KEY_TAG, null)
            ?.takeIf { it.isNotBlank() }

    /** Persist (or clear, when [tag] is null) the language override. */
    fun setTag(context: Context, tag: String?) {
        context.applicationContext
            .getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .edit()
            .apply { if (tag.isNullOrBlank()) remove(KEY_TAG) else putString(KEY_TAG, tag) }
            .apply()
    }

    /** Wrap [base] with the overridden locale (no-op when following the system language). */
    fun wrap(base: Context): Context {
        val tag = currentTag(base) ?: return base
        val locale = Locale.forLanguageTag(tag)
        Locale.setDefault(locale)
        val config = Configuration(base.resources.configuration)
        config.setLocale(locale)
        config.setLayoutDirection(locale)
        return base.createConfigurationContext(config)
    }
}
