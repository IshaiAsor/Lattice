#pragma once
#include "actions/commands/OnboardLedCommandAction.h"
#include "actions/DynamicDeviceActionsService.h"

// Status LED — always present, used directly by SmartHome.cpp for boot feedback.
// Not managed by DynamicDeviceActionsService.
static OnboardLedAction onboardLed("onboardLed", 48);
