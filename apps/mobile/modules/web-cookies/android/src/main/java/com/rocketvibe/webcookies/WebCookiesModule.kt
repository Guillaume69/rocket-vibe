package com.rocketvibe.webcookies

import android.webkit.CookieManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The cookies a sign-in web view received, read from the app's shared
 * CookieManager, which keeps HttpOnly cookies out of the page's reach but
 * not out of the app's: Slack's session cookie is one. `clear` empties the
 * store once a sign-in has read what it needed, so no session stays there.
 */
class WebCookiesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WebCookies")

    /** The `name=value` pairs CookieManager would send to `url`, or "" when none. */
    Function("get") { url: String ->
      CookieManager.getInstance().getCookie(url) ?: ""
    }

    AsyncFunction("clear") { promise: Promise ->
      val cookies = CookieManager.getInstance()
      cookies.removeAllCookies { _ ->
        cookies.flush()
        promise.resolve(null)
      }
    }
  }
}
