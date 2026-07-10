// Per-implementation_type command validation, mirroring the firmware command classes'
// BaseCommandAction::validateActionPayload (ESP32Code/src/actions/commands/*). Keyed off the
// catalog `implementation_type` (= the C++ class name, confirmed in CapabilityRegistry.h).
//
// Firmware accepts a value when it is in the class's valid-parameter list OR (for classes
// constructed with a range) it is an integer within [min,max]. Anything else is rejected — the
// device acks status:"error" instead of executing.
//
// RESERVED VERB: `{"value":"read"}` is NOT a command parameter — both firmware and sim
// intercept it BEFORE validation (MqttActionsHandlerService / SimDevice._onMessage) and reply
// on the ack topic with the action's current NVS-persisted state, executing nothing. The MODELS
// tables below therefore never list "read", and validate() is never reached for it.

const MODELS = {
  // OutletCommandAction(name, pins, {"1","0","on","off"})
  OutletCommandAction: { valid: ['1', '0', 'on', 'off'] },
  // LightDimmerAction(name, pins, {"off","on"}, useRange=true, 0, 100)
  LightDimmerAction: { valid: ['off', 'on'], range: [0, 100] },
  // OneDirectionalMotorAction(name, pins, {"off","on"}, useRange=true, 0, 100)
  OneDirectionalMotorAction: { valid: ['off', 'on'], range: [0, 100] },
  // PwmOutputAction(name, pins, {"off","on"}, useRange=true, 0, 100)
  PwmOutputAction: { valid: ['off', 'on'], range: [0, 100] },
  // I2cSocket8Action / I2cSocket16Action(name, pins, {"1","0","on","off"}) — outlet-like on/off
  // per relay channel on a PCF8574 / MCP23017 I2C expander (no I2C hardware in the sim).
  I2cSocket8Action: { valid: ['1', '0', 'on', 'off'] },
  I2cSocket16Action: { valid: ['1', '0', 'on', 'off'] },
};

function isIntInRange(value, [min, max]) {
  const s = String(value).trim();
  if (!/^-?\d+$/.test(s)) return false; // firmware allows a leading '-' then digits
  const n = parseInt(s, 10);
  return n >= min && n <= max;
}

// True if `value` is a valid command for the given implementation type. Unknown impl types
// (e.g. capabilities the sim doesn't model) are accepted optimistically.
function validate(implType, value) {
  const m = MODELS[implType];
  if (!m) return true;
  const s = String(value);
  if (m.valid.includes(s)) return true;
  if (m.range && isIntInRange(s, m.range)) return true;
  return false;
}

// Firmware stores `state = action` (the raw string) and acks that as the applied value.
function normalize(value) {
  return String(value);
}

module.exports = { MODELS, validate, normalize, isIntInRange };
