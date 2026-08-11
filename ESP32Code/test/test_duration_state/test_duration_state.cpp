// Duration persistence (F11.10) — what a command action saves and what it does with it at boot.
//
// The bug this exists for: the countdown used to live only in RAM, so a device that rebooted
// mid-hold came back with "on" restored from NVS and no timer armed. It stayed on forever, and the
// server was correctly told "on", which is exactly why nobody noticed. These pin the two decisions
// that stop that: what gets written, and what a restored value means.

#include <unity.h>
#include "actions/commands/DurationState.h"

static const time_t MIN_VALID = 24 * 3600; // mirrors settings.h — an unsynced ESP RTC starts at 0

void test_encode_without_deadline_is_just_the_state(void)
{
    TEST_ASSERT_EQUAL_STRING("on", DurationState::encode("on", 0).c_str());
    TEST_ASSERT_EQUAL_STRING("on", DurationState::encode("on", -5).c_str());
}

void test_encode_with_deadline_appends_it(void)
{
    TEST_ASSERT_EQUAL_STRING("on|1700000000", DurationState::encode("on", 1700000000).c_str());
}

void test_decode_a_value_written_before_deadlines_existed(void)
{
    // No separator: an upgrade must read the old shape as "state, no deadline" rather than
    // failing — that is what makes this need no migration.
    DurationState::Saved s = DurationState::decode("on");
    TEST_ASSERT_EQUAL_STRING("on", s.state.c_str());
    TEST_ASSERT_EQUAL(0, (long)s.deadline);
}

void test_decode_round_trips(void)
{
    DurationState::Saved s = DurationState::decode(DurationState::encode("50", 1700000123));
    TEST_ASSERT_EQUAL_STRING("50", s.state.c_str());
    TEST_ASSERT_EQUAL(1700000123, (long)s.deadline);
}

void test_decode_ignores_a_garbled_tail(void)
{
    // Corruption must not invent an expiry — that would switch a device off for no reason.
    DurationState::Saved s = DurationState::decode("on|not-a-number");
    TEST_ASSERT_EQUAL_STRING("on", s.state.c_str());
    TEST_ASSERT_EQUAL(0, (long)s.deadline);
}

void test_restore_without_a_deadline_arms_nothing(void)
{
    DurationState::RestorePlan p = DurationState::planRestore(DurationState::decode("on"), 1700000000, MIN_VALID);
    TEST_ASSERT_TRUE(p.action == DurationState::Restore::NoDeadline);
}

void test_restore_after_the_deadline_is_expired(void)
{
    // The reboot case: down for longer than the hold. Came back on before this.
    DurationState::RestorePlan p =
        DurationState::planRestore(DurationState::decode("on|1700000000"), 1700000060, MIN_VALID);
    TEST_ASSERT_TRUE(p.action == DurationState::Restore::Expired);
}

void test_restore_before_the_deadline_keeps_the_remainder(void)
{
    DurationState::RestorePlan p =
        DurationState::planRestore(DurationState::decode("on|1700000060"), 1700000000, MIN_VALID);
    TEST_ASSERT_TRUE(p.action == DurationState::Restore::Remaining);
    TEST_ASSERT_EQUAL(60, p.remainingSeconds);
}

void test_restore_with_an_unsynced_clock_is_expired(void)
{
    // NTP has not answered, so the RTC still reads ~0. An actuator holding a timed state with no
    // way to tell whether the time has passed must stop: for a valve, off is the only safe guess.
    DurationState::RestorePlan p = DurationState::planRestore(DurationState::decode("on|1700000000"), 0, MIN_VALID);
    TEST_ASSERT_TRUE(p.action == DurationState::Restore::Expired);
}

void test_restore_exactly_at_the_deadline_is_expired(void)
{
    DurationState::RestorePlan p =
        DurationState::planRestore(DurationState::decode("on|1700000000"), 1700000000, MIN_VALID);
    TEST_ASSERT_TRUE(p.action == DurationState::Restore::Expired);
}

// Unity's fixtures — nothing to set up, but the linker wants them.
void setUp() {}
void tearDown() {}

int main(int, char**)
{
    UNITY_BEGIN();
    RUN_TEST(test_encode_without_deadline_is_just_the_state);
    RUN_TEST(test_encode_with_deadline_appends_it);
    RUN_TEST(test_decode_a_value_written_before_deadlines_existed);
    RUN_TEST(test_decode_round_trips);
    RUN_TEST(test_decode_ignores_a_garbled_tail);
    RUN_TEST(test_restore_without_a_deadline_arms_nothing);
    RUN_TEST(test_restore_after_the_deadline_is_expired);
    RUN_TEST(test_restore_before_the_deadline_keeps_the_remainder);
    RUN_TEST(test_restore_with_an_unsynced_clock_is_expired);
    RUN_TEST(test_restore_exactly_at_the_deadline_is_expired);
    return UNITY_END();
}
