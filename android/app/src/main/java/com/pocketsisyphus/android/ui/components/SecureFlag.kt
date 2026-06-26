package com.pocketsisyphus.android.ui.components

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext

/**
 * BL-07: 이 컴포저블이 화면에 있는 동안 호스트 Activity 창에 `FLAG_SECURE` 를 건다 —
 * 스크린샷·앱 스위처 썸네일·화면공유에서 내용이 가려진다(검은 프레임).
 *
 * 민감 화면(페어링: 원시 페어링 페이로드·붙여넣기 / 세션 상세: 원격 셸·채팅)에만 적용해
 * 베타 테스터가 비-민감 화면은 그대로 캡처할 수 있게 한다. 참조 카운트로 여러 민감 화면을
 * 오가도(예: 페어링→세션) 플래그가 «마지막 화면이 떠날 때만» 해제돼 빈틈/플리커가 없다.
 */
@Composable
fun SecureFlag() {
    val context = LocalContext.current
    DisposableEffect(Unit) {
        val window = context.findActivity()?.window
        secureRefCount++
        window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose {
            secureRefCount--
            if (secureRefCount <= 0) {
                secureRefCount = 0
                window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
    }
}

/** 동시에 떠 있는 «보안 화면» 수. 0 이 되는 순간에만 FLAG_SECURE 를 내린다. */
private var secureRefCount = 0

/** Compose 의 LocalContext 는 ContextWrapper 일 수 있어 Activity 까지 언랩한다. */
private fun Context.findActivity(): Activity? {
    var ctx: Context? = this
    while (ctx is ContextWrapper) {
        if (ctx is Activity) return ctx
        ctx = ctx.baseContext
    }
    return null
}
