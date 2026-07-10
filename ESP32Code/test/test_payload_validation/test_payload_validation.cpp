// Native unit test for PayloadValidation::isValid — the firmware side of the command-payload
// parity contract with tools/device-sim/lib/command-models.js. The case matrix mirrors
// tests/unit/commands.command-models.test.js so the two stay in lock-step.
#include <unity.h>
#include "actions/commands/PayloadValidation.h"

using PayloadValidation::isValid;

// OutletCommandAction: valid list {"1","0","on","off"}, no range.
static const std::vector<std::string> OUTLET = {"1", "0", "on", "off"};
// LightDimmerAction / OneDirectionalMotorAction / PwmOutputAction: valid {"off","on"} + range [0,100].
static const std::vector<std::string> RANGED = {"off", "on"};

void test_valid_list_accepts_members()
{
    TEST_ASSERT_TRUE(isValid("on", OUTLET, false, 0, 0));
    TEST_ASSERT_TRUE(isValid("off", OUTLET, false, 0, 0));
    TEST_ASSERT_TRUE(isValid("1", OUTLET, false, 0, 0));
    TEST_ASSERT_TRUE(isValid("0", OUTLET, false, 0, 0));
}

void test_valid_list_rejects_non_members()
{
    TEST_ASSERT_FALSE(isValid("2", OUTLET, false, 0, 0));
    TEST_ASSERT_FALSE(isValid("ON", OUTLET, false, 0, 0)); // case-sensitive
    TEST_ASSERT_FALSE(isValid("", OUTLET, false, 0, 0));
    TEST_ASSERT_FALSE(isValid("50", OUTLET, false, 0, 0)); // no range configured
}

void test_range_accepts_bounds_inclusive()
{
    TEST_ASSERT_TRUE(isValid("0", RANGED, true, 0, 100));
    TEST_ASSERT_TRUE(isValid("100", RANGED, true, 0, 100));
    TEST_ASSERT_TRUE(isValid("50", RANGED, true, 0, 100));
}

void test_range_rejects_out_of_range()
{
    TEST_ASSERT_FALSE(isValid("-1", RANGED, true, 0, 100));
    TEST_ASSERT_FALSE(isValid("101", RANGED, true, 0, 100));
    TEST_ASSERT_FALSE(isValid("999999999999999999999", RANGED, true, 0, 100)); // overflow → out of range
}

void test_range_still_accepts_valid_words()
{
    TEST_ASSERT_TRUE(isValid("on", RANGED, true, 0, 100));
    TEST_ASSERT_TRUE(isValid("off", RANGED, true, 0, 100));
}

void test_non_numeric_rejected_in_range()
{
    TEST_ASSERT_FALSE(isValid("abc", RANGED, true, 0, 100));
    TEST_ASSERT_FALSE(isValid("5x", RANGED, true, 0, 100));
    TEST_ASSERT_FALSE(isValid("", RANGED, true, 0, 100));
    // Matches the sim's /^-?\d+$/: a lone "-" is not a number (pre-refactor firmware
    // accepted it as 0 — this is the divergence PayloadValidation removes).
    TEST_ASSERT_FALSE(isValid("-", RANGED, true, 0, 100));
}

void setUp() {}
void tearDown() {}

int main(int, char**)
{
    UNITY_BEGIN();
    RUN_TEST(test_valid_list_accepts_members);
    RUN_TEST(test_valid_list_rejects_non_members);
    RUN_TEST(test_range_accepts_bounds_inclusive);
    RUN_TEST(test_range_rejects_out_of_range);
    RUN_TEST(test_range_still_accepts_valid_words);
    RUN_TEST(test_non_numeric_rejected_in_range);
    return UNITY_END();
}
