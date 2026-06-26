# sshj + BouncyCastle rely on reflection for algorithm factories.
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
-keep class net.schmizz.** { *; }
-keep class com.hierynomus.** { *; }
-dontwarn net.schmizz.**
-dontwarn org.slf4j.**
-keep class net.i2p.crypto.eddsa.** { *; }
# eddsa 의 EdDSAEngine 이 참조하는 JDK 내부 클래스(안드로이드엔 부재) — 경고만 끈다.
-dontwarn sun.security.x509.X509Key

# kotlinx.serialization — 1.9.0 ships consumer R8 rules in its AAR, but keep these as
# belt-and-suspenders for the generated $$serializer members + annotation/InnerClasses attrs.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class **$$serializer { *; }

# JNA (Vosk's native binding runtime) — heavy reflection + JNI; R8 must not rename/strip it,
# else on-device voice dictation crashes at runtime (the build itself still succeeds).
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-dontwarn com.sun.jna.**
-dontwarn java.awt.**

# Vosk (on-device speech-to-text) — JNI bindings.
-keep class org.vosk.** { *; }
-dontwarn org.vosk.**

# Tor (Guardian Project tor-android + jtorctl) — JNI + control-protocol reflection.
-keep class org.torproject.** { *; }
-keep class net.freehaven.tor.control.** { *; }
-keep class IPtProxy.** { *; }
-dontwarn org.torproject.**
-dontwarn IPtProxy.**
