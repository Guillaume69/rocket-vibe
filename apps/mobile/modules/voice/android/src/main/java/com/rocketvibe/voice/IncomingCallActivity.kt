package com.rocketvibe.voice

import android.app.Activity
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup.LayoutParams
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The full-screen incoming call, shown over the lock screen. It only answers
 * (dismiss the keyguard, then open the app on the call) or declines: the
 * MainActivity itself never shows over the lock screen, so no chat leaks there.
 */
class IncomingCallActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    val ring = intent.getStringExtra(VoiceRinging.EXTRA_RING) ?: return finish()
    val caller = intent.getStringExtra(VoiceRinging.EXTRA_CALLER).orEmpty()
    val answer = intent.getStringExtra(VoiceRinging.EXTRA_ANSWER) ?: return finish()
    @Suppress("DEPRECATION")
    val decline = intent.getParcelableExtra<PendingIntent>(VoiceRinging.EXTRA_DECLINE)
    VoiceRinging.attach(this)

    val density = resources.displayMetrics.density
    fun dp(v: Int) = (v * density).toInt()
    fun round(color: Int) = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setBackgroundColor(Color.parseColor("#0E0C1D"))
      setPadding(dp(32), dp(32), dp(32), dp(32))
    }
    root.addView(TextView(this).apply {
      text = caller; textSize = 30f; setTextColor(Color.parseColor("#F3F0FF")); gravity = Gravity.CENTER
    })
    root.addView(TextView(this).apply {
      text = getString(R.string.voice_incoming); textSize = 16f; setTextColor(Color.parseColor("#A79FC8"))
      gravity = Gravity.CENTER; setPadding(0, dp(8), 0, dp(64))
    })
    val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
    fun button(label: String, color: String, onClick: () -> Unit) = Button(this).apply {
      text = label; textSize = 26f; background = round(Color.parseColor(color)); setTextColor(Color.WHITE)
      contentDescription = label
      setOnClickListener { onClick() }
      layoutParams = LinearLayout.LayoutParams(dp(76), dp(76)).apply { setMargins(dp(28), 0, dp(28), 0) }
    }
    actions.addView(button("✕", "#FF7A8A") {
      try { decline?.send() } catch (_: PendingIntent.CanceledException) {}
      VoiceRinging.cancel(this, ring)
      finish()
    }.apply { contentDescription = getString(R.string.voice_decline) })
    actions.addView(button("✓", "#3ED67F") { answer(ring, answer) }.apply { contentDescription = getString(R.string.voice_accept) })
    root.addView(actions, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    setContentView(root)
  }

  private fun answer(ring: String, link: String) {
    val open = {
      VoiceRinging.cancel(this, ring)
      startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      finish()
    }
    val keyguard = getSystemService(KeyguardManager::class.java)
    if (keyguard != null && keyguard.isKeyguardLocked && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() { open() }
      })
    } else open()
  }
}
