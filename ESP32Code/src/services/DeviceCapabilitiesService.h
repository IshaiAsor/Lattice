#pragma once
#include <vector>
#include "actions/manifest/CapabilityRegistry.h"

// Thin wrapper kept for call-site compatibility (JwtService::Provision). The capability
// manifest itself lives in CapabilityRegistry, which is also compiled by the host
// generator under tools/manifest-gen so firmware and build-time manifest never diverge.
class DeviceCapabilitiesService
{
  public:
    static std::vector<CapabilityDescriptor> getCapabilities() { return CapabilityRegistry::all(); }
};
