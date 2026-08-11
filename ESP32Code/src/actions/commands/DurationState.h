#pragma once
#include <string>
#include <ctime>

// What a command action persists: its state, and — when it was told to hold that state for a
// while — the wall-clock moment it should stop.
//
// Before this, only the state was saved. The countdown lived in RAM (`millis()`), so a device that
// rebooted mid-duration came back, restored "on" from NVS, armed nothing, and stayed on forever.
// The server was correctly told "on", which is what made it hard to see: nothing was broken, the
// valve was simply never told to close. A blueprint could only defend against it with a separate
// "close everything overnight" rule.
//
// Kept in ONE NVS value rather than two keys because ESP32 Preferences keys are capped at 15
// characters and action names already reach 14 (`i2c_socket_8_2`). The encoding is therefore
// `state` or `state|deadlineEpoch`, and a value written before this existed has no separator and
// reads back as "no deadline" — so an upgrade needs no migration.
//
// Arduino-free so `pio test -e native` can pin it; see PARITY.md.
namespace DurationState
{
/** The parsed form of a stored value. */
struct Saved
{
    std::string state;
    /** 0 = none. Wall-clock epoch seconds, not millis: it has to survive the reboot. */
    time_t deadline = 0;
};

inline std::string encode(const std::string& state, time_t deadline)
{
    if (deadline <= 0)
        return state;
    return state + "|" + std::to_string((long long)deadline);
}

inline Saved decode(const std::string& stored)
{
    Saved                        out;
    const std::string::size_type bar = stored.find('|');
    if (bar == std::string::npos)
    {
        out.state = stored;
        return out;
    }
    out.state = stored.substr(0, bar);
    // A malformed tail is treated as no deadline rather than as zero-remaining: the value came
    // from our own writer, so a garbled one means corruption, and inventing an expiry from it
    // would switch a device off for no reason.
    const std::string tail = stored.substr(bar + 1);
    if (!tail.empty() && tail.find_first_not_of("0123456789") == std::string::npos)
        out.deadline = (time_t)std::stoll(tail);
    return out;
}

/**
 * What a device should do with a restored value at boot.
 *
 * `nowEpoch` must be a real clock — pass 0 (or anything below the caller's validity floor) when NTP
 * has not answered yet. In that case the answer is EXPIRED, deliberately: an actuator holding a
 * timed state with no way to know whether the time has passed should stop, not continue. For a
 * valve or a heater, "off" is the only safe guess.
 */
enum class Restore
{
    NoDeadline, ///< restore the state and arm nothing — how every pre-duration action behaves
    Expired,    ///< the hold is over (or unknowable): apply the resting state instead
    Remaining,  ///< still within the hold: restore the state and re-arm for `remainingSeconds`
};

struct RestorePlan
{
    Restore action           = Restore::NoDeadline;
    long    remainingSeconds = 0;
};

inline RestorePlan planRestore(const Saved& saved, time_t nowEpoch, time_t minValidEpoch)
{
    RestorePlan plan;
    if (saved.deadline <= 0)
    {
        plan.action = Restore::NoDeadline;
        return plan;
    }
    if (nowEpoch < minValidEpoch || nowEpoch >= saved.deadline)
    {
        plan.action = Restore::Expired;
        return plan;
    }
    plan.action           = Restore::Remaining;
    plan.remainingSeconds = (long)(saved.deadline - nowEpoch);
    return plan;
}
} // namespace DurationState
