import config from '../config/env.config';
import { JwtPurpose, jwtService } from './jwt.service';

// Device-facing provisioning (provisionDevice, RefreshMqttToken, permanent-token minting)
// moved to services/device-gateway. Only the app-facing provisioning-token mint remains.
class ProvisioningService {
  async GenerateProvisioningToken(userId: number) {
    const tokenPayload = { userId, clientid: String(userId) };
    const token = jwtService.generateToken(tokenPayload, JwtPurpose.device_provisioning);
    console.log(`Generated provisioning token for user ${userId}`);

    // /provision lives on device-gateway now — point the device straight at it.
    const provisioningCallbackUrl = `${config.deviceGatewayUrl}/api/provisioning/provision`;
    return {
      provisioningToken: token,
      userId: userId.toString(),
      server: config.mqtt.serverName,
      mqttPort: config.mqtt.port,
      provisioningCallbackUrl,
      validateCACert: config.mqtt.validateCert,
    };
  }
}

export const provisioningService = new ProvisioningService();
