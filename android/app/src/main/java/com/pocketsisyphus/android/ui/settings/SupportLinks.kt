package com.pocketsisyphus.android.ui.settings

/**
 * Single source of truth for community / support external links — mirrors iOS `CommunityLinks`.
 * Help routes to the public GitHub Discussions hub (no in-app forum / feedback backend); Share
 * hands the project home link to the system share sheet. Keep these here so a URL change is a
 * one-line edit, never scattered across call sites.
 */
internal object SupportLinks {
    /** «Help» destination — public GitHub Discussions, opened in an external browser. */
    const val DISCUSSIONS = "https://github.com/Wayne-Kim/pocket-sisyphus/discussions"

    /** «Share» payload — the project home, so a recipient can find the app. */
    const val PROJECT_HOME = "https://github.com/Wayne-Kim/pocket-sisyphus"
}
