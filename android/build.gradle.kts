plugins {
    id("com.android.application") version "9.1.1"
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10"
}

android {
    namespace = "io.starpost.mobile"
    compileSdk = 37
    defaultConfig {
        applicationId = "io.starpost.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 19
        versionName = "1.8.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    sourceSets {
        getByName("main") { manifest.srcFile("AndroidManifest.xml"); java.setSrcDirs(listOf("src")); kotlin.directories += "src"; res.setSrcDirs(listOf("res")) }
        getByName("test") { java.setSrcDirs(listOf("unit-tests")); kotlin.directories += "unit-tests" }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildTypes { getByName("release") { isMinifyEnabled = true; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro") } }
    packaging { resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1") }
    testOptions { unitTests.isIncludeAndroidResources = true }
}

tasks.withType<Test>().configureEach {
    maxHeapSize = "1536m"
    systemProperty("robolectric.dependency.repo.url", "https://repo.maven.apache.org/maven2")
    val runtimeTemp = layout.buildDirectory.dir("robolectric-tmp")
    doFirst { runtimeTemp.get().asFile.mkdirs() }
    systemProperty("java.io.tmpdir", runtimeTemp.get().asFile.absolutePath)
}

dependencies {
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    implementation("androidx.activity:activity-compose:1.12.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.compose.ui:ui:1.12.0")
    implementation("androidx.compose.ui:ui-tooling-preview:1.12.0")
    implementation("androidx.compose.foundation:foundation:1.12.0")
    implementation("androidx.compose.material3:material3:1.5.0-beta02")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    debugImplementation("androidx.compose.ui:ui-tooling:1.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("androidx.compose.ui:ui-test-junit4:1.12.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest:1.12.0")
}
