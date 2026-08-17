// Native unit test for TopicBuilder — the MQTT topic construction extracted from mqtt.h.
// Firmware analog of the backend topic-parser test (tests/unit/telemetry.topic-parser.test.ts).
#include <unity.h>
#include "services/TopicBuilder.h"

// Mirrors the templates in config/settings.h so a template edit that breaks substitution
// shows up here.
static const char* COMMAND   = "users/%{userid}/devices/%{deviceid}/%{version}/command/#";
static const char* TELEMETRY = "users/%{userid}/devices/%{deviceid}/%{version}/telemetry/#";
static const char* STATUS    = "users/%{userid}/devices/%{deviceid}/%{version}/status";

void test_build_fills_all_placeholders()
{
    std::string t = TopicBuilder::build(COMMAND, "u1", "d1", "v2.0.208");
    TEST_ASSERT_EQUAL_STRING("users/u1/devices/d1/v2.0.208/command/#", t.c_str());
}

void test_build_leaves_hash_untouched()
{
    std::string t = TopicBuilder::build(TELEMETRY, "u1", "d1", "v1");
    TEST_ASSERT_EQUAL_STRING("users/u1/devices/d1/v1/telemetry/#", t.c_str());
}

void test_build_for_action_substitutes_hash()
{
    std::string t = TopicBuilder::buildForAction(TELEMETRY, "u1", "d1", "v1", "temperature");
    TEST_ASSERT_EQUAL_STRING("users/u1/devices/d1/v1/telemetry/temperature", t.c_str());
}

void test_status_has_no_hash()
{
    std::string t = TopicBuilder::build(STATUS, "u1", "d1", "v1");
    TEST_ASSERT_EQUAL_STRING("users/u1/devices/d1/v1/status", t.c_str());
}

void test_replace_all_is_idempotent_without_placeholder()
{
    std::string t = TopicBuilder::replaceAll("no/placeholder/here", "#", "x");
    TEST_ASSERT_EQUAL_STRING("no/placeholder/here", t.c_str());
}

void setUp() {}
void tearDown() {}

int main(int, char**)
{
    UNITY_BEGIN();
    RUN_TEST(test_build_fills_all_placeholders);
    RUN_TEST(test_build_leaves_hash_untouched);
    RUN_TEST(test_build_for_action_substitutes_hash);
    RUN_TEST(test_status_has_no_hash);
    RUN_TEST(test_replace_all_is_idempotent_without_placeholder);
    return UNITY_END();
}
