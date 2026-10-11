package com.rocketvibe.exactalarms

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Whether reminders may use exact alarms, and the system screen that grants
 * them. expo-notifications sets an exact alarm only when
 * `canScheduleExactAlarms()`; without it a date trigger becomes an inexact
 * alarm the system may deliver much later (up to 75 % of the delay). The
 * permission (`SCHEDULE_EXACT_ALARM`, declared in app.json) exists from
 * Android 12 and is off by default from 14.
 */
class ExactAlarmsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExactAlarms")

    Function("canSchedule") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function true
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      alarms.canScheduleExactAlarms()
    }

    /** Opens "Alarms and reminders" for this app; false when the system has no such screen. */
    Function("openSettings") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function false
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + context.packageName))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(intent)
        true
      } catch (e: Exception) {
        false
      }
    }
  }
}
