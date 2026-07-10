#pragma once
// Pure command-payload validation — no Arduino dependency, so it compiles in host
// (native test) builds. Extracted verbatim from BaseCommandAction::validateActionPayload
// so the exact acceptance semantics can be unit-tested and kept in lock-step with the
// simulator's tools/device-sim/lib/command-models.js (the PARITY.md rail).
//
// Semantics (must not drift): accept if the value equals any entry in validParameters;
// OR, when a range is configured, if the value is an integer (optional leading '-', then
// one-or-more digits) within [rangeMin, rangeMax] inclusive. The integer form matches the
// simulator's /^-?\d+$/ exactly — including rejecting a lone "-" (the pre-refactor
// BaseCommandAction accepted "-" as 0 via String::toInt, a latent firmware↔sim divergence
// this fold removes; see PARITY.md).
#include <string>
#include <vector>

namespace PayloadValidation
{
// True iff `value` is a base-10 integer literal: an optional leading '-' followed by
// one or more digits, nothing else. Empty string is not a number.
inline bool isIntLiteral(const std::string& value)
{
    if (value.empty())
        return false;
    for (size_t i = 0; i < value.size(); i++)
    {
        char c     = value[i];
        bool digit = (c >= '0' && c <= '9');
        if (!digit && !(i == 0 && c == '-'))
            return false;
    }
    // A lone "-" is not a number.
    return !(value.size() == 1 && value[0] == '-');
}

inline bool isValid(const std::string& value, const std::vector<std::string>& validParameters, bool hasRange,
                    int rangeMin, int rangeMax)
{
    for (const auto& p : validParameters)
    {
        if (value == p)
            return true;
    }
    if (hasRange && isIntLiteral(value))
    {
        // A value that overflows `long` is necessarily outside the small [min,max]
        // ranges this validates (0..100 in practice) — treat as out of range, not a throw.
        try
        {
            long v = std::stol(value);
            if (v >= rangeMin && v <= rangeMax)
                return true;
        }
        catch (...)
        {
        }
    }
    return false;
}
} // namespace PayloadValidation
