package io.starpost.mobile

import java.io.File

// AndroidX FileProvider checks root + "/" (correct on Android). Robolectric on
// Windows uses host File paths instead. Model the Android child separator in
// tests only; retain the real root so provider scoping is still exercised.
internal fun providerTestFile(file:File):File {
    // Robolectric creates a different app cacheDir for each test while AndroidX's
    // authority cache can survive across sandboxes. Rebuild it against this test's
    // real roots; do not bypass FileProvider's scope validation.
    org.robolectric.util.ReflectionHelpers.getStaticField<MutableMap<*,*>>(androidx.core.content.FileProvider::class.java,"sCache").clear()
    return if(File.separatorChar!='\\')file else object:File(file.path) {
        override fun getCanonicalPath()=parentFile!!.canonicalPath+"/"+name
    }
}
