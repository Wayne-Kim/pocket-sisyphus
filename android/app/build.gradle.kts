import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// 릴리스 서명 — keystore.properties(.gitignore, 메인테이너 전용)가 있을 때만 활성화.
// 없으면 contributors 의 `assembleRelease` 는 debug 서명으로 떨어져 그대로 빌드된다.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
    namespace = "com.pocketsisyphus.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.pocketsisyphus.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        // The daemon's `/api/*` gate (mac/daemon/src/version.ts MIN_SUPPORTED_CLIENT_VERSION)
        // rejects an `X-Client-Version` below 0.2.0 with 426. We send that header, so the
        // client version must be >= the daemon minimum.
        versionName = "0.2.0"
    }

    signingConfigs {
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            // BL-11: R8 축소·난독화 활성 — Attestation·PairStore·ed25519SeedFromPkcs8 등
            // 보안 클래스명이 APK 에 그대로 남던 리버싱 격차를 줄인다. crypto/네이티브 리플렉션
            // (sshj·BouncyCastle·eddsa·JNA·Vosk·tor)은 proguard-rules.pro 의 -keep 로 보존.
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // keystore.properties 가 있으면 릴리스 키로, 없으면 debug 서명으로 폴백.
            signingConfig = if (keystorePropsFile.exists())
                signingConfigs.getByName("release")
            else
                signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // sshj + BouncyCastle ship multi-release jars and signed META-INF entries that the
    // Android packager rejects / duplicates. Keep the base classes, drop the noise.
    packaging {
        resources {
            excludes += setOf(
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE",
                "META-INF/LICENSE.txt",
                "META-INF/LICENSE.md",
                "META-INF/NOTICE",
                "META-INF/NOTICE.txt",
                "META-INF/NOTICE.md",
                "META-INF/INDEX.LIST",
                "META-INF/*.kotlin_module",
                "META-INF/versions/**",
                "META-INF/BCKEY.SF",
                "META-INF/BCKEY.DSA",
                "META-INF/BC2048KE.SF",
                "META-INF/BC2048KE.DSA",
            )
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.09.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")

    // On-device speech-to-text (offline, downloadable per-language model) — Android equivalent of the
    // iPhone's WhisperKit voice dictation. Vosk runs 100% on-device; only the model weights download
    // once (public weights, not user audio). JNA is Vosk's native-binding runtime dependency.
    implementation("com.alphacephei:vosk-android:0.3.47")
    implementation("net.java.dev.jna:jna:5.13.0@aar")

    // HTTP + WebSocket (OkHttp covers both; no Retrofit needed).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // SSH local port-forward transport.
    implementation("com.hierynomus:sshj:0.40.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.84")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.84")
    implementation("net.i2p.crypto:eddsa:0.3.0")
    implementation("org.slf4j:slf4j-nop:2.0.16")

    // Encrypted storage for the pairing secret bundle.
    implementation("androidx.security:security-crypto:1.1.0")

    // Google Play Billing — Pro subscription (monthly/yearly) + lifetime license.
    implementation("com.android.billingclient:billing-ktx:7.1.1")

    // Device-attestation key gating — BiometricPrompt (Face/fingerprint) unlocks the
    // Android-Keystore signing key, mirroring iOS Face ID / LAContext lost-phone protection.
    // BiometricPrompt requires a FragmentActivity host.
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.fragment:fragment-ktx:1.8.5")

    // In-process Tor (Guardian Project) — onion bootstrap + local SOCKS5 for the Tor data
    // plane (/endpoint lookup over onion + tor_onion SSH fallback). Ships the tor binary +
    // jtorctl control library transitively. Pinned to 0.4.8.19: the last release whose AAR
    // metadata compiles against compileSdk 36 (0.4.9.x requires compileSdk 37).
    implementation("info.guardianproject:tor-android:0.4.8.19")
    implementation("info.guardianproject:jtorctl:0.4.5.7")

    // QR pairing: camera preview + barcode detection.
    implementation("androidx.camera:camera-camera2:1.6.1")
    implementation("androidx.camera:camera-lifecycle:1.6.1")
    implementation("androidx.camera:camera-view:1.6.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    testImplementation("junit:junit:4.13.2")
}
