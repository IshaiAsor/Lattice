#pragma once
// Pure MQTT topic construction — no Arduino dependency, so it compiles in host
// (manifest-gen, native tests) builds too. Mirrors the placeholder scheme in
// config/settings.h: %{userid} / %{deviceid} / %{version} / %{devicetype}, and the
// trailing "#" wildcard slot that per-action topics substitute with the action name.
//
// Tested by test/test_topic_builder (native). Firmware analog of the backend
// topic-parser (tests/unit/telemetry.topic-parser.test.ts).
#include <string>

namespace TopicBuilder
{
inline std::string replaceAll(std::string s, const std::string& from, const std::string& to)
{
    if (from.empty())
        return s;
    size_t pos = 0;
    while ((pos = s.find(from, pos)) != std::string::npos)
    {
        s.replace(pos, from.length(), to);
        pos += to.length();
    }
    return s;
}

// Fills the user/device/version placeholders. Leaves any trailing "#" untouched so the
// caller can either subscribe with the wildcard or substitute a concrete action name.
inline std::string build(const std::string& tmpl, const std::string& userId, const std::string& deviceId,
                         const std::string& version)
{
    std::string out = replaceAll(tmpl, "%{userid}", userId);
    out             = replaceAll(out, "%{deviceid}", deviceId);
    out             = replaceAll(out, "%{version}", version);
    return out;
}

// Same as build(), then replaces the "#" wildcard slot with a concrete action name —
// used for the per-action telemetry/ack topics.
inline std::string buildForAction(const std::string& tmpl, const std::string& userId, const std::string& deviceId,
                                  const std::string& version, const std::string& actionName)
{
    return replaceAll(build(tmpl, userId, deviceId, version), "#", actionName);
}
} // namespace TopicBuilder
