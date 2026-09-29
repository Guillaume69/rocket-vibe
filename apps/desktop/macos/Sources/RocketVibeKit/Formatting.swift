import Foundation

/// Times as the GTK app writes them.
public enum Formatting {
    static func date(_ ts: Int64) -> Date {
        Date(timeIntervalSince1970: TimeInterval(ts) / 1000)
    }

    static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: Strings.french ? "fr_FR" : "en_US")
        f.dateFormat = format
        return f
    }

    static func days(from ts: Int64, to now: Date, calendar: Calendar) -> Int {
        let start = calendar.startOfDay(for: date(ts))
        return calendar.dateComponents([.day], from: start, to: calendar.startOfDay(for: now)).day ?? 0
    }

    /// `14:05`.
    public static func time(_ ts: Int64) -> String {
        formatter("HH:mm").string(from: date(ts))
    }

    /// The room list's: the time today, the weekday this week, else the date.
    public static func shortTime(_ ts: Int64, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard ts > 0 else { return "" }
        switch days(from: ts, to: now, calendar: calendar) {
        case 0: return time(ts)
        case 1..<7: return formatter("EEE").string(from: date(ts))
        default: return formatter("dd/MM/yyyy").string(from: date(ts))
        }
    }

    /// The separator above a day's first message.
    public static func day(_ ts: Int64, now: Date = Date(), calendar: Calendar = .current) -> String {
        switch days(from: ts, to: now, calendar: calendar) {
        case 0: return L("day.today")
        case 1: return L("day.yesterday")
        default: return formatter("EEEE d MMMM yyyy").string(from: date(ts))
        }
    }
}
