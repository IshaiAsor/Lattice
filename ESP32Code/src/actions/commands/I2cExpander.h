#pragma once
#include <Arduino.h>
#include <Wire.h>
#include "config/Log.h"

// Shared I2C port-expander access for the per-socket command actions.
//
// The "one action per socket" model means several I2cSocket*Action instances can target the
// SAME physical expander (same I2C address) on different channels. These chips latch all of
// their outputs in a single bus write, so a naive "write my channel" would clobber the other
// channels' bits. This helper keeps the last-written port register per address and does a
// read-modify-write in software, so sibling sockets on one expander coexist correctly. The
// cache starts all-off at boot; each action's NVS state restore ORs its own bit back in.
//
// Convention: bit = 1 → channel ON (output driven high). Active-low relay boards invert this
// in hardware; wire/label accordingly.
namespace I2cExpander
{

// Tiny fixed-capacity, heap-free cache of one port register per I2C address. CAP covers far
// more expanders than a single device would ever carry on one bus.
template <typename T> struct PortCache
{
    static constexpr int CAP = 8;
    uint8_t              addr[CAP];
    T                    value[CAP];
    int                  count = 0;

    T& get(uint8_t a)
    {
        for (int i = 0; i < count; i++)
            if (addr[i] == a)
                return value[i];
        if (count < CAP)
        {
            addr[count]  = a;
            value[count] = 0;
            return value[count++];
        }
        // Pathological overflow — reuse slot 0 rather than grow the heap.
        addr[0]  = a;
        value[0] = 0;
        return value[0];
    }
};

// ---- PCF8574 (8-bit quasi-bidirectional port; one byte drives all 8 outputs) ----

inline PortCache<uint8_t>& pcf8574Cache()
{
    static PortCache<uint8_t> cache;
    return cache;
}

inline bool pcf8574SetChannel(uint8_t addr, uint8_t channel, bool on)
{
    if (channel > 7)
    {
        LOG_W("I2C", "PCF8574 channel %u out of range (0-7)", channel);
        return false;
    }
    uint8_t& port = pcf8574Cache().get(addr);
    if (on)
        port |= (uint8_t)(1u << channel);
    else
        port &= (uint8_t)(~(1u << channel));

    Wire.beginTransmission(addr);
    Wire.write(port);
    bool ok = (Wire.endTransmission() == 0);
    if (!ok)
        LOG_W("I2C", "PCF8574 write failed @0x%02X", addr);
    return ok;
}

// ---- MCP23017 (16-bit, two 8-bit ports; register-based) ----

static constexpr uint8_t MCP_IODIRA = 0x00; // 1 = input, 0 = output
static constexpr uint8_t MCP_IODIRB = 0x01;
static constexpr uint8_t MCP_GPIOA  = 0x12;
static constexpr uint8_t MCP_GPIOB  = 0x13;

inline bool mcpWriteReg(uint8_t addr, uint8_t reg, uint8_t val)
{
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.write(val);
    return Wire.endTransmission() == 0;
}

inline PortCache<uint16_t>& mcp23017Cache()
{
    static PortCache<uint16_t> cache;
    return cache;
}

// Configure both ports as outputs, once per address (idempotent).
inline bool mcp23017EnsureInit(uint8_t addr)
{
    static uint8_t inited[8];
    static int     initedCount = 0;
    for (int i = 0; i < initedCount; i++)
        if (inited[i] == addr)
            return true;
    bool ok = mcpWriteReg(addr, MCP_IODIRA, 0x00) && mcpWriteReg(addr, MCP_IODIRB, 0x00);
    if (ok && initedCount < 8)
        inited[initedCount++] = addr;
    return ok;
}

inline bool mcp23017SetChannel(uint8_t addr, uint8_t channel, bool on)
{
    if (channel > 15)
    {
        LOG_W("I2C", "MCP23017 channel %u out of range (0-15)", channel);
        return false;
    }
    mcp23017EnsureInit(addr);
    uint16_t& port = mcp23017Cache().get(addr);
    if (on)
        port |= (uint16_t)(1u << channel);
    else
        port &= (uint16_t)(~(1u << channel));

    bool ok = mcpWriteReg(addr, MCP_GPIOA, port & 0xFF) && mcpWriteReg(addr, MCP_GPIOB, (port >> 8) & 0xFF);
    if (!ok)
        LOG_W("I2C", "MCP23017 write failed @0x%02X", addr);
    return ok;
}

} // namespace I2cExpander
