#pragma once
#include <vector>
#include <string>
#include <Arduino.h>
#include <Wire.h>
#include "BaseCommandAction.h"
#include "actions/commands/I2cExpander.h"
#include "actions/manifest/CapabilityRegistry.h"
#include "config/Log.h"

// One power socket/relay on an MCP23017 16-bit I2C expander (two 8-bit ports). Same
// "one action per socket" model as I2cSocket8Action, for boards with up to 16 relays; sibling
// sockets on the same expander share a cached 16-bit port register (see I2cExpander). Bus,
// address, and channel (0-15) are configured per instance via the pin slots.
class I2cSocket16Action : public BaseCommandAction
{
  public:
    static const PinSlotDef*     blueprint() { return CapabilityRegistry::i2cSocket16().pins; }
    static const char*           googleActionType() { return CapabilityRegistry::i2cSocket16().googleType; }
    static const GoogleTraitDef* supportedTraits() { return CapabilityRegistry::i2cSocket16().traits; }
    static CapabilityDescriptor  capability() { return CapabilityRegistry::i2cSocket16(); }
    static const char*           implType() { return capability().implType; }

  private:
    int     sdaPin;
    int     sclPin;
    uint8_t i2cAddress;
    uint8_t channel;

  public:
    I2cSocket16Action(String name, std::vector<ActionPinsSetup> pins)
        : BaseCommandAction(name, pins, {"1", "0", "on", "off"})
    {
        sdaPin     = pins.size() > 0 ? pins[0].PIN_NUMBER : SDA;
        sclPin     = pins.size() > 1 ? pins[1].PIN_NUMBER : SCL;
        i2cAddress = pins.size() > 2 ? (uint8_t)pins[2].PIN_NUMBER : 0x20;
        channel    = pins.size() > 3 ? (uint8_t)pins[3].PIN_NUMBER : 0;
    }

    // I2C bus, not GPIO — start Wire instead of pinMode-ing the (pseudo) pin slots.
    void initPins() override { Wire.begin(sdaPin, sclPin); }

    void executeValidAction(String action) override
    {
        bool on = (strcmp(action.c_str(), "1") == 0 || strcmp(action.c_str(), "on") == 0);
        I2cExpander::mcp23017SetChannel(i2cAddress, channel, on);
        LOG_D("Cmd", "socket ch%u @0x%02X %s", channel, i2cAddress, on ? "ON" : "OFF");
    }
};
