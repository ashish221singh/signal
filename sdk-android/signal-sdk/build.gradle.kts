plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
  id("com.google.devtools.ksp")
}
android {
  namespace = "com.beatroute.signal"
  compileSdk = 34
  defaultConfig { minSdk = 24 }
  buildTypes { release { isMinifyEnabled = false } }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
  testOptions { unitTests { isIncludeAndroidResources = true } }
}

// F2-D14: web-core is a BUNDLED build artifact, never fetched at show time. The IIFE
// bundle is committed under src/main/assets/web-core/, but this task re-copies it from
// the workspace dist when that dist is present (freshly built via
// `pnpm --filter @signal/web-core build`) so the shipped asset never drifts from the
// renderer. When the dist is absent (Android-only checkout / CI without Node) it is a
// no-op and the committed asset is used as-is.
val syncWebCore by tasks.registering(Copy::class) {
  val dist = rootProject.file("../packages/web-core/dist/web-core.global.js")
  onlyIf { dist.exists() }
  from(dist)
  into(layout.projectDirectory.dir("src/main/assets/web-core"))
}
tasks.named("preBuild") { dependsOn(syncWebCore) }
dependencies {
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
  implementation("androidx.room:room-runtime:2.6.1")
  implementation("androidx.room:room-ktx:2.6.1")
  ksp("androidx.room:room-compiler:2.6.1")
  implementation("androidx.datastore:datastore-preferences:1.1.1")
  implementation("androidx.work:work-runtime-ktx:2.9.1")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.fragment:fragment-ktx:1.8.2")
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.robolectric:robolectric:4.13")
  testImplementation("androidx.test:core:1.6.1")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
  testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
  testImplementation("androidx.work:work-testing:2.9.1")
}
